/**
 * UrjaAudit feature module: bill check, bill history & trends, rooftop solar planner.
 * Loaded after app.js and uses its helpers: $, state, api, num, inr, esc, compact,
 * toast, confirmDialog, debounce, refreshAllData, REDUCED_MOTION.
 */

const VERDICT_TONE = { ok: 'ok', slightly_high: 'warn', slightly_low: 'warn', high: 'bad', low: 'bad', unknown: 'neutral' };
const VERDICT_ICON = { ok: '✅', warn: '⚠️', bad: '🚨', neutral: 'ℹ️' };
const FLAG_LABEL = { spike: 'Unusually high', drop: 'Unusually low', bill_mismatch: 'Bill ≠ slab estimate' };

const signedInr = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${inr(Math.abs(n), d)}`;

/** "Jun 2026" -> "Jun '26" so bar-chart labels fit. */
function shortMonth(label) {
  const text = String(label || '').trim();
  const m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(?:\d{2})?(\d{2})$/.exec(text);
  if (m) return `${m[1]} '${m[2]}`;
  return text.length > 7 ? `${text.slice(0, 6)}…` : text;
}

function renderFeatures() {
  renderDashVerdict();
  renderBillCheck();
  renderBillHistory();
}

// -------------------------------------------------------------
// Dashboard verdict strip
// -------------------------------------------------------------
function renderDashVerdict() {
  const el = $('dash-verdict');
  const c = state.summary?.billCheck;
  if (!c || c.status === 'unknown') {
    el.hidden = true;
    return;
  }
  const tone = VERDICT_TONE[c.status] || 'neutral';
  el.hidden = false;
  el.className = `verdict-strip verdict-${tone}`;
  el.innerHTML = `
    <span class="verdict-icon" aria-hidden="true">${VERDICT_ICON[tone]}</span>
    <span class="verdict-strip-text"><strong>${esc(c.headline)}</strong><small>${esc(c.detail)}</small></span>
    <span class="verdict-link">View bill check →</span>`;
}

// -------------------------------------------------------------
// Bill check card
// -------------------------------------------------------------
function renderBillCheck() {
  const box = $('bill-check-body');
  const c = state.summary?.billCheck;

  if (!c || c.status === 'unknown') {
    box.innerHTML = '<div class="empty-state"><span class="big">🧾</span>Save a bill above and we will check it against the tariff slabs.</div>';
    return;
  }

  const tone = VERDICT_TONE[c.status] || 'neutral';
  const list = (items) => `<ul class="reason-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

  box.innerHTML = `
    <div class="verdict verdict-${tone}">
      <span class="verdict-icon" aria-hidden="true">${VERDICT_ICON[tone]}</span>
      <div><h4>${esc(c.headline)}</h4><p>${esc(c.detail)}</p></div>
    </div>

    <div class="verdict-numbers">
      <div class="stat-box"><span class="label">Your bill</span><strong>${inr(state.bill?.actual_bill_amount ?? 0)}</strong></div>
      <div class="stat-box"><span class="label">Slab estimate</span><strong>${inr(c.expectedAmount)}</strong>
        <small>Energy ${inr(c.breakdown.energyCharges, 0)} · Fixed ${inr(c.breakdown.fixedCharges, 0)} · Duty ${inr(c.breakdown.electricityDuty, 0)}</small></div>
      <div class="stat-box ${c.status === 'ok' ? 'accent' : ''}"><span class="label">Difference</span><strong>${signedInr(c.difference)}</strong><small>${c.percent > 0 ? '+' : ''}${num(c.percent, 1)}%</small></div>
    </div>

    ${c.reasons.length ? `<h5 class="check-sub">Possible reasons</h5>${list(c.reasons)}` : ''}
    ${c.nextSteps.length ? `<h5 class="check-sub">What you can do</h5>${list(c.nextSteps)}` : ''}
    ${c.notes.map((n) => `<div class="check-note">💡 ${esc(n)}</div>`).join('')}
    <p class="calc-note">This check uses the slab rates stored in this app. Real bills can include other charges, so treat it as a guide and compare with the rates printed on your bill.</p>`;
}

// -------------------------------------------------------------
// Bill history
// -------------------------------------------------------------
function renderBillHistory() {
  const h = state.summary?.billHistory;
  const points = h?.points || [];

  $('history-insights').innerHTML = (h?.insights || [])
    .map((t) => `<li>${esc(t)}</li>`).join('');

  const shown = points.slice(-12);
  renderBarChart('history-chart', shown.map((p) => ({
    label: shortMonth(p.label),
    value: p.units,
    flagged: p.flags.some((f) => f.type === 'spike' || f.type === 'drop')
  })), {
    average: h?.averageUnits || 0,
    unitLabel: 'kWh',
    yFormat: (v) => String(Math.round(v))
  });

  const tbody = $('history-tbody');
  if (!points.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No bills saved yet. Enter one above to start your history.</div></td></tr>';
    return;
  }

  tbody.innerHTML = points.map((p) => {
    const diff = p.amount - p.expectedAmount;
    const warn = Math.abs(p.billDiffPercent) > 15;
    const flags = p.flags.map((f) => `<span class="flag-pill flag-${esc(f.type)}" title="${esc(f.text)}">${esc(FLAG_LABEL[f.type] || f.type)}</span>`).join('');
    return `
      <tr>
        <td><strong>${esc(p.label)}</strong></td>
        <td>${num(p.units, 1)} kWh</td>
        <td>${inr(p.amount)}</td>
        <td>${inr(p.ratePerUnit)}</td>
        <td><span class="${warn ? 'diff-warn' : 'diff-ok'}">${signedInr(diff, 0)} (${p.billDiffPercent > 0 ? '+' : ''}${num(p.billDiffPercent, 1)}%)</span></td>
        <td>${flags || '—'}</td>
        <td><button class="btn btn-danger" data-bill-id="${p.id}" aria-label="Delete ${esc(p.label)} bill">🗑</button></td>
      </tr>`;
  }).join('');
}

async function deleteBillRecord(id) {
  const p = state.summary?.billHistory?.points.find((x) => x.id === id);
  const ok = await confirmDialog(`Remove the ${p ? p.label : 'selected'} bill from your history?`, 'Delete');
  if (!ok) return;
  try {
    await api(`/api/bill/${state.sessionId}/${id}`, { method: 'DELETE' });
    await refreshAllData();
    toast('Bill removed');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// Solar planner
// -------------------------------------------------------------
function initSolar() {
  const m = state.summary?.metrics;
  if (!m) return;

  const history = state.summary.billHistory;
  let suggested = 0;
  let source = '';
  if (history && history.count >= 2 && history.averageUnits > 0) {
    suggested = history.averageUnits;
    source = `the average of your ${history.count} saved bills`;
  } else if (state.bill) {
    suggested = m.actualUnitsKwh;
    source = 'your latest bill';
  } else if (m.totalCalculatedMonthlyKwh > 0) {
    suggested = m.totalCalculatedMonthlyKwh;
    source = 'your appliance list';
  }

  if (!state.solarUnitsTouched) $('solar-units').value = suggested > 0 ? Math.round(suggested) : '';
  $('solar-units-hint').textContent = suggested > 0
    ? `Prefilled from ${source}. Change it if you like.`
    : 'Add appliances or a bill first, or type your monthly units.';

  runSolar();
}

function showSolarEmpty() {
  $('solar-empty').hidden = false;
  $('solar-results').hidden = true;
  state.solar = null;
  renderReportExtras();
}

async function runSolar() {
  if (!state.summary) return;
  const units = Number($('solar-units').value);
  const sun = Number($('solar-sun').value);
  const cost = Number($('solar-cost').value);
  const offset = Number($('solar-offset').value);

  // Stay quiet while the person is still typing an incomplete or out-of-range value
  if (!(units > 0) || !(sun >= 2 && sun <= 7) || !(cost >= 20000 && cost <= 150000)) {
    if (!(units > 0)) showSolarEmpty();
    return;
  }

  try {
    const d = await api('/api/solar/calculate', {
      method: 'POST',
      body: JSON.stringify({
        monthlyUnits: units,
        sunHours: sun,
        costPerKw: cost,
        offsetPercent: offset,
        applySubsidy: $('solar-subsidy').checked,
        sanctionedLoad: Number(state.summary.session?.sanctioned_load_kw) || 2
      })
    });
    state.solar = d;
    renderSolar(d);
    renderReportExtras();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSolar(d) {
  $('solar-empty').hidden = true;
  $('solar-results').hidden = false;

  $('solar-size').textContent = `${num(d.sizeKw, 1)} kW`;
  $('solar-roof').textContent = `About ${num(d.roofAreaSqM, 0)} m² of roof`;
  $('solar-gen').textContent = `${num(d.monthlyGeneration, 0)} kWh`;
  $('solar-cover').textContent = `Covers ${num(d.coveragePercent, 0)}% of your use`;
  $('solar-gross').textContent = inr(d.grossCost, 0);
  $('solar-subsidy-amt').textContent = d.subsidy > 0 ? inr(d.subsidy, 0) : 'None';
  $('solar-net').textContent = inr(d.netCost, 0);
  $('solar-savings').textContent = inr(d.monthlySavings, 0);
  $('solar-bill-change').textContent = `Bill ${inr(d.billBefore, 0)} → ${inr(d.billAfter, 0)}`;
  $('solar-payback').textContent = d.paybackYears === null ? 'Over 25 years' : `${num(d.paybackYears, 1)} years`;
  $('solar-gain').textContent = `${d.netGain25Years < 0 ? '−' : ''}${inr(Math.abs(d.netGain25Years), 0)}`;
  $('solar-co2').textContent = `${num(d.co2AvoidedYearKg, 0)} kg`;
  $('solar-trees').textContent = `Like ${num(d.treesEquivalent, 0)} trees a year`;

  renderLineChart('solar-chart', d.cashflow.map((c) => ({ x: c.year, y: c.value })), {
    xTickEvery: 5,
    xLabel: 'Years',
    breakEven: d.paybackYears && d.paybackYears > 0 && d.paybackYears <= 25 ? d.paybackYears : null,
    breakEvenUnit: 'yr',
    yFormat: (v) => `${v < 0 ? '−' : ''}₹${compact(Math.abs(v))}`
  });

  $('solar-note').textContent = d.paybackYears === null
    ? 'With these inputs the system does not pay back within 25 years. Try a lower cost per kW or include the subsidy.'
    : `You pay ${inr(d.netCost, 0)} after subsidy and recover it in about ${num(d.paybackYears, 1)} years. Over 25 years the system could put about ${inr(d.netGain25Years, 0)} in your pocket. Estimates only: get vendor quotes and confirm current subsidy rules before deciding.`;
}

// -------------------------------------------------------------
// Report sections
// -------------------------------------------------------------
function renderReportExtras() {
  if (!state.summary) return;

  // Bill verification
  const c = state.summary.billCheck;
  const box = $('report-bill-check');
  if (c && c.status !== 'unknown') {
    const tone = VERDICT_TONE[c.status] || 'neutral';
    box.className = `report-bill-check verdict-${tone}`;
    box.innerHTML = `<strong>${esc(c.headline)}</strong><p>${esc(c.detail)}</p>${c.notes.map((n) => `<p>${esc(n)}</p>`).join('')}`;
  } else {
    box.className = '';
    box.innerHTML = '<p class="rec-desc">No bill entered yet.</p>';
  }

  // History table
  const points = state.summary.billHistory?.points || [];
  $('report-history-tbody').innerHTML = points.length
    ? points.map((p) => `
        <tr>
          <td><strong>${esc(p.label)}</strong></td>
          <td>${num(p.units, 1)}</td>
          <td>${inr(p.amount)}</td>
          <td>${signedInr(p.amount - p.expectedAmount, 0)} (${p.billDiffPercent > 0 ? '+' : ''}${num(p.billDiffPercent, 1)}%)</td>
          <td>${p.flags.length ? esc(p.flags.map((f) => FLAG_LABEL[f.type]).join(', ')) : '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="5">No bills saved.</td></tr>';

  // Solar (only when the person has run the planner)
  const d = state.solar;
  $('report-solar-section').hidden = !d;
  if (d) {
    $('report-solar').innerHTML = `
      <ul class="report-solar-list">
        <li><strong>System size:</strong> ${num(d.sizeKw, 1)} kW (about ${num(d.roofAreaSqM, 0)} m²)</li>
        <li><strong>Generation:</strong> ${num(d.monthlyGeneration, 0)} kWh / month</li>
        <li><strong>Upfront cost:</strong> ${inr(d.grossCost, 0)}</li>
        <li><strong>Subsidy (estimate):</strong> ${inr(d.subsidy, 0)}</li>
        <li><strong>You pay:</strong> ${inr(d.netCost, 0)}</li>
        <li><strong>Bill savings:</strong> ${inr(d.monthlySavings, 0)} / month</li>
        <li><strong>Payback:</strong> ${d.paybackYears === null ? 'Over 25 years' : `${num(d.paybackYears, 1)} years`}</li>
        <li><strong>CO₂ avoided:</strong> ${num(d.co2AvoidedYearKg, 0)} kg / year</li>
      </ul>
      <p class="calc-note">Planning estimate only. Costs, sunlight and subsidy rules vary, so confirm with installers and the official portal.</p>`;
  }
}

// -------------------------------------------------------------
// Event listeners (called from setupEventListeners in app.js)
// -------------------------------------------------------------
function setupFeatureListeners() {
  // Bill history
  $('history-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bill-id]');
    if (btn) deleteBillRecord(Number(btn.dataset.billId));
  });

  $('btn-add-month').addEventListener('click', () => {
    $('bill-month').value = '';
    $('actual-units').value = '';
    $('actual-amount').value = '';
    updateBillPreview();
    $('bill-form-card').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    $('bill-month').focus();
  });

  // Solar planner
  const liveSolar = debounce(runSolar, 300);
  $('form-solar').addEventListener('submit', (e) => { e.preventDefault(); runSolar(); });
  $('solar-units').addEventListener('input', () => { state.solarUnitsTouched = true; liveSolar(); });
  ['solar-sun', 'solar-cost'].forEach((id) => $(id).addEventListener('input', liveSolar));
  $('solar-offset').addEventListener('input', () => {
    $('solar-offset-val').textContent = $('solar-offset').value;
    liveSolar();
  });
  $('solar-subsidy').addEventListener('change', runSolar);
  $('btn-solar-reset').addEventListener('click', () => {
    $('solar-sun').value = 4.5;
    $('solar-cost').value = 60000;
    $('solar-offset').value = 100;
    $('solar-offset-val').textContent = '100';
    $('solar-subsidy').checked = true;
    state.solarUnitsTouched = false;
    initSolar();
  });
}