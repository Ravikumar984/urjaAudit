/**
 * UrjaAudit bill analysis: checks one bill against the tariff slabs,
 * and finds trends / unusual months in a bill history.
 */
const { calculateTariffCost } = require('./calculator');

const money = (n) => `₹${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-IN')}`;
const round1 = (n) => Number(Number(n).toFixed(1));

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Compare a bill against the slab estimate.
 * Status: ok (within 5%), slightly_high / slightly_low (5-15%), high / low (over 15%), unknown.
 */
function checkBill({ units, amount, slabs, sanctionedLoad = 2, calculatedUnits = 0 }) {
  const u = Number(units);
  const a = Number(amount);

  if (!Number.isFinite(u) || !Number.isFinite(a) || u <= 0) {
    return {
      status: 'unknown',
      headline: 'Not enough information',
      detail: 'Enter the units and amount from your bill to check it.',
      expectedAmount: 0, difference: 0, percent: 0,
      breakdown: null, reasons: [], nextSteps: [], notes: []
    };
  }

  const est = calculateTariffCost(u, slabs, sanctionedLoad);
  const expected = est.totalEstimatedBill;
  const difference = Number((a - expected).toFixed(2));
  const percent = expected > 0 ? round1((difference / expected) * 100) : 0;
  const abs = Math.abs(percent);
  const unitsText = round1(u);

  let status;
  let headline;
  let detail;
  let reasons = [];
  let nextSteps = [];

  if (abs <= 5) {
    status = 'ok';
    headline = 'Your bill matches the tariff slabs';
    detail = `For ${unitsText} units we calculate about ${money(expected)} and your bill is ${money(a)}, which is within 5%.`;
    nextSteps = ['Keep a photo of each bill so you can track your trend in the history below.'];
  } else if (difference > 0) {
    status = abs > 15 ? 'high' : 'slightly_high';
    headline = abs > 15 ? 'Your bill is much higher than expected' : 'Your bill is a little higher than expected';
    detail = `Your bill is ${money(difference)} (${abs}%) above the ${money(expected)} we calculate for ${unitsText} units.`;
    reasons = [
      'Arrears, a late-payment surcharge or meter rent may be included in the amount.',
      'Extra charges such as fuel or power-purchase cost adjustments may be added on top of the slab rates.',
      'The slab rates in this app may differ from your current tariff order. Compare them with the rates printed on your bill.'
    ];
    nextSteps = [
      'Look for separate lines on the bill (arrears, surcharge, other charges) and subtract them.',
      'Compare the previous and current readings on the bill with the reading shown on your meter.'
    ];
    if (abs > 15) nextSteps.push('If the gap is still unexplained, ask your electricity office to review the bill or test the meter.');
  } else {
    status = abs > 15 ? 'low' : 'slightly_low';
    headline = abs > 15 ? 'Your bill is much lower than expected' : 'Your bill is a little lower than expected';
    detail = `Your bill is ${money(difference)} (${abs}%) below the ${money(expected)} we calculate for ${unitsText} units.`;
    reasons = [
      'A subsidy, rebate or advance balance may have been applied.',
      'The slab rates in this app may differ from your current tariff order.',
      'The units or amount you entered may not match the bill exactly.'
    ];
    nextSteps = ['Re-check the units and amount you typed against the bill.'];
  }

  const notes = [];
  if (calculatedUnits > 0) {
    const ratio = u / calculatedUnits;
    if (ratio > 1.3) {
      notes.push(`Your bill shows ${Math.round((ratio - 1) * 100)}% more units than your appliance list explains. You may be missing appliances (geyser, water pump, chargers) or have standby loads.`);
    } else if (ratio < 0.7) {
      notes.push(`Your appliance list adds up to ${Math.round((1 / ratio - 1) * 100)}% more units than your bill. Check that wattage and daily hours are not overstated.`);
    }
  }

  return {
    status,
    headline,
    detail,
    expectedAmount: Number(expected.toFixed(2)),
    difference,
    percent,
    breakdown: {
      energyCharges: est.energyCharges,
      fixedCharges: est.fixedCharges,
      electricityDuty: est.electricityDuty
    },
    reasons,
    nextSteps,
    notes
  };
}

/**
 * Analyse bills in the order they were added.
 * records: rows with { id, billing_month, actual_units_kwh, actual_bill_amount }
 */
function analyzeHistory(records, slabs, sanctionedLoad = 2) {
  const points = (records || []).map((r) => {
    const units = Number(r.actual_units_kwh);
    const amount = Number(r.actual_bill_amount);
    const expected = calculateTariffCost(units, slabs, sanctionedLoad).totalEstimatedBill;
    const diffPct = expected > 0 ? ((amount - expected) / expected) * 100 : 0;
    return {
      id: r.id,
      label: r.billing_month,
      units,
      amount,
      expectedAmount: Number(expected.toFixed(2)),
      billDiffPercent: round1(diffPct),
      ratePerUnit: units > 0 ? Number((amount / units).toFixed(2)) : 0,
      flags: []
    };
  });

  const n = points.length;
  const insights = [];

  // Unusual months: compare each month with the median of the others (needs 3+ months)
  if (n >= 3) {
    points.forEach((p, i) => {
      const med = median(points.filter((_, j) => j !== i).map((x) => x.units));
      if (med <= 0) return;
      if (p.units > med * 1.25) {
        p.flags.push({ type: 'spike', text: `${Math.round((p.units / med - 1) * 100)}% above your typical month` });
      } else if (p.units < med * 0.6) {
        p.flags.push({ type: 'drop', text: `${Math.round((1 - p.units / med) * 100)}% below your typical month` });
      }
    });
  }
  points.forEach((p) => {
    if (p.units > 0 && Math.abs(p.billDiffPercent) > 15) {
      p.flags.push({ type: 'bill_mismatch', text: `Bill is ${Math.abs(p.billDiffPercent)}% ${p.billDiffPercent > 0 ? 'above' : 'below'} the slab estimate` });
    }
  });

  const unitsList = points.map((p) => p.units);
  const averageUnits = n ? round1(unitsList.reduce((s, v) => s + v, 0) / n) : 0;
  const averageAmount = n ? Number((points.reduce((s, p) => s + p.amount, 0) / n).toFixed(2)) : 0;
  const highest = n ? points.reduce((best, p) => (p.units > best.units ? p : best), points[0]) : null;
  const lowest = n ? points.reduce((best, p) => (p.units < best.units ? p : best), points[0]) : null;

  // Change from the previous month
  let changeFromPrevious = null;
  if (n >= 2 && points[n - 2].units > 0) {
    const prev = points[n - 2];
    const last = points[n - 1];
    changeFromPrevious = {
      units: round1(last.units - prev.units),
      percent: round1(((last.units - prev.units) / prev.units) * 100)
    };
  }

  // Trend: slope of a straight line through the units, as % of the average per month
  let trend = 'unknown';
  let trendPercentPerMonth = 0;
  if (n >= 3 && averageUnits > 0) {
    const xMean = (n - 1) / 2;
    let sxy = 0;
    let sxx = 0;
    points.forEach((p, i) => {
      sxy += (i - xMean) * (p.units - averageUnits);
      sxx += (i - xMean) ** 2;
    });
    trendPercentPerMonth = round1(((sxy / sxx) / averageUnits) * 100);
    trend = trendPercentPerMonth > 4 ? 'rising' : trendPercentPerMonth < -4 ? 'falling' : 'stable';
  }

  // Plain-language insights
  if (n < 2) {
    insights.push('Add at least 2 months of bills to compare, and 3 or more to see trends and unusual months.');
  } else {
    if (changeFromPrevious) {
      const c = changeFromPrevious.percent;
      if (Math.abs(c) < 1) insights.push('Your latest bill used about the same units as the previous month.');
      else insights.push(`Your latest bill used ${Math.abs(c)}% ${c > 0 ? 'more' : 'fewer'} units than the previous month.`);
    }
    if (trend === 'rising') insights.push(`Usage is trending up by about ${trendPercentPerMonth}% a month. Check for new appliances or longer AC and fan hours.`);
    if (trend === 'falling') insights.push(`Usage is trending down by about ${Math.abs(trendPercentPerMonth)}% a month. Your savings habits seem to be working.`);
    if (trend === 'stable') insights.push('Your usage is steady from month to month.');
    points.filter((p) => p.flags.some((f) => f.type === 'spike')).forEach((p) => {
      insights.push(`${p.label} looks unusually high (${round1(p.units)} kWh). Think about guests, a faulty appliance or a meter problem that month.`);
    });
    points.filter((p) => p.flags.some((f) => f.type === 'drop')).forEach((p) => {
      insights.push(`${p.label} looks unusually low (${round1(p.units)} kWh). It may be a holiday, a seasonal dip or a meter reading issue.`);
    });
  }

  return {
    points,
    count: n,
    averageUnits,
    averageAmount,
    highest,
    lowest,
    changeFromPrevious,
    trend,
    trendPercentPerMonth,
    flaggedCount: points.filter((p) => p.flags.some((f) => f.type === 'spike' || f.type === 'drop')).length,
    insights
  };
}

module.exports = { checkBill, analyzeHistory };