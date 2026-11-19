/**
 * UrjaAudit rooftop solar estimator.
 * These are planning estimates only. Get vendor quotes and confirm the current
 * subsidy rules (pmsuryaghar.gov.in) before making a purchase decision.
 */
const { calculateTariffCost } = require('./calculator');

const PERFORMANCE_RATIO = 0.8;   // real-world losses (dust, heat, inverter, wiring)
const DEGRADATION = 0.007;       // panel output drops ~0.7% per year
const LIFETIME_YEARS = 25;
const CO2_PER_KWH = 0.8;         // kg CO2 per kWh, approximate Indian grid average
const KG_CO2_PER_TREE_YEAR = 21; // approximate
const SQ_M_PER_KW = 10;          // rough roof area per kW
const MAX_RESIDENTIAL_KW = 10;

/**
 * PM Surya Ghar central assistance (as announced in 2024):
 * Rs 30,000 per kW for the first 2 kW, Rs 18,000 for the 3rd kW, capped at Rs 78,000.
 * Rules can change, so the UI tells users to confirm on the official portal.
 */
function pmSuryaGharSubsidy(kw) {
  const first = Math.min(kw, 2) * 30000;
  const third = Math.min(Math.max(kw - 2, 0), 1) * 18000;
  return Math.min(78000, Math.round(first + third));
}

function calculateSolar({
  monthlyUnits,
  sunHours = 4.5,
  costPerKw = 60000,
  offsetPercent = 100,
  applySubsidy = true,
  sanctionedLoadKw = 2,
  slabs = []
}) {
  const genPerKwMonth = sunHours * PERFORMANCE_RATIO * 30;
  const targetUnits = monthlyUnits * (offsetPercent / 100);

  // Size to the nearest 0.5 kW above the target, between 1 kW and the residential cap
  let sizeKw = Math.ceil((targetUnits / genPerKwMonth) * 2) / 2;
  sizeKw = Math.max(1, Math.min(sizeKw, MAX_RESIDENTIAL_KW));

  const monthlyGeneration = sizeKw * genPerKwMonth;
  // Surplus is assumed not to earn credit, which keeps the estimate conservative
  const unitsOffset = Math.min(monthlyGeneration, monthlyUnits);

  // Savings use the real slabs: bill now minus bill after solar
  const billBefore = calculateTariffCost(monthlyUnits, slabs, sanctionedLoadKw).totalEstimatedBill;
  const billAfter = calculateTariffCost(Math.max(0, monthlyUnits - unitsOffset), slabs, sanctionedLoadKw).totalEstimatedBill;
  const monthlySavings = Math.max(0, billBefore - billAfter);
  const annualSavings = monthlySavings * 12;

  const grossCost = Math.round(sizeKw * costPerKw);
  const subsidy = applySubsidy ? Math.min(pmSuryaGharSubsidy(sizeKw), grossCost) : 0;
  const netCost = grossCost - subsidy;

  // Year-by-year cash flow with panel degradation (no tariff increases assumed)
  let cumulative = -netCost;
  let paybackYears = netCost <= 0 ? 0 : null;
  const cashflow = [{ year: 0, value: Math.round(cumulative) }];
  for (let year = 1; year <= LIFETIME_YEARS; year += 1) {
    const savings = annualSavings * Math.pow(1 - DEGRADATION, year - 1);
    const before = cumulative;
    cumulative += savings;
    if (paybackYears === null && before < 0 && cumulative >= 0 && savings > 0) {
      paybackYears = (year - 1) + (-before / savings);
    }
    cashflow.push({ year, value: Math.round(cumulative) });
  }

  const co2AvoidedYearKg = monthlyGeneration * 12 * CO2_PER_KWH;

  return {
    sizeKw,
    roofAreaSqM: Math.round(sizeKw * SQ_M_PER_KW),
    monthlyGeneration: Number(monthlyGeneration.toFixed(1)),
    unitsOffset: Number(unitsOffset.toFixed(1)),
    coveragePercent: Number(((unitsOffset / monthlyUnits) * 100).toFixed(0)),
    grossCost,
    subsidy,
    netCost,
    billBefore: Number(billBefore.toFixed(2)),
    billAfter: Number(billAfter.toFixed(2)),
    monthlySavings: Number(monthlySavings.toFixed(2)),
    annualSavings: Number(annualSavings.toFixed(2)),
    paybackYears: paybackYears === null ? null : Number(paybackYears.toFixed(1)),
    netGain25Years: Math.round(cumulative),
    co2AvoidedYearKg: Math.round(co2AvoidedYearKg),
    treesEquivalent: Number((co2AvoidedYearKg / KG_CO2_PER_TREE_YEAR).toFixed(0)),
    cashflow,
    assumptions: {
      sunHours, costPerKw, performanceRatio: PERFORMANCE_RATIO,
      degradationPerYear: DEGRADATION, lifetimeYears: LIFETIME_YEARS,
      surplusCredited: false, tariffIncreasesAssumed: false
    }
  };
}

module.exports = { calculateSolar, pmSuryaGharSubsidy };