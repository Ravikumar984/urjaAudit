/**
 * UrjaAudit Core Frontend Application Controller
 *
 * Every page load starts a brand-new, empty audit session.
 * The session id is kept in memory only, so each visitor and each refresh
 * starts with an empty appliance list.
 *
 * Bill check, bill history and the solar planner live in features.js
 * (loaded after this file, uses the helpers defined here).
 */

// -------------------------------------------------------------
// State & constants
// -------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  activeScreen: 'screen-dashboard',
  summary: null,
  appliances: [],
  bill: null,
  tariffs: [],
  filters: { q: '', category: '', sort: 'default' },
  roiTariffSeeded: false,
  solar: null,
  solarUnitsTouched: false
};

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Rough constants for the carbon estimates (shown as estimates in the UI)
const CO2_PER_KWH = 0.8;          // kg CO2 per kWh, approximate Indian grid average
const KG_CO2_PER_TREE_YEAR = 21;  // kg CO2 absorbed by one tree per year, approximate

const SLAB_COLORS = ['#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444'];

const CATEGORY_ICONS = {
  Lighting: '💡', Cooling: '🌀', Refrigeration: '🧊',
  Entertainment: '📺', 'Heavy Motor': '⚙️', Other: '🔌'
};
const catIcon = (c) => CATEGORY_ICONS[c] || '🔌';

const PRESETS = [
  { name: 'LED Bulb (9W)', category: 'Lighting', wattage: 9, hours: 6 },
  { name: 'Ceiling Fan (75W Induction)', category: 'Cooling', wattage: 75, hours: 10 },
  { name: 'BLDC Ceiling Fan (28W)', category: 'Cooling', wattage: 28, hours: 10 },
  { name: 'Television 43 inch (100W)', category: 'Entertainment', wattage: 100, hours: 4 },
  { name: 'Refrigerator 190L (150W Avg)', category: 'Refrigeration', wattage: 150, hours: 8 },
  { name: 'Split Air Conditioner 1.5T (1500W)', category: 'Cooling', wattage: 1500, hours: 6 },
  { name: 'Immersion Water Heater (1500W)', category: 'Heavy Motor', wattage: 1500, hours: 1 },
  { name: 'Washing Machine (400W)', category: 'Other', wattage: 400, hours: 1 },
  { name: 'Water Pump 1HP (746W)', category: 'Heavy Motor', wattage: 746, hours: 1 }
];

// -------------------------------------------------------------
// Utilities
// -------------------------------------------------------------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const num = (n, d = 1) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const inr = (n, d = 2) => '₹' + num(n, d);
const compact = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : String(Math.round(v)));

function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

let loadingCount = 0;
function setLoading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  $('loading-bar').classList.toggle('active', loadingCount > 0);
}

function toast(message, type = 'success') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'error' ? '⚠️' : type === 'info' ? 'ℹ️' : '✅';
  el.innerHTML = `<span aria-hidden="true">${icon}</span><span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 5000 : 2800);
}

function animateText(el, to, formatter, duration = 700) {
  if (!el) return;
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (REDUCED_MOTION || from === to) {
    el.textContent = formatter(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatter(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function confirmDialog(message, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const dialog = $('dialog-confirm');
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel;
    dialog.returnValue = '';
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

function downloadCSV(filename, rows) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Client-side mirror of the server's tariff calculation (for live previews). */
function estimateBill(units, slabs, sanctionedLoad) {
  if (!slabs.length) return null;
  let remaining = Math.max(0, units);
  let energy = 0;
  for (const slab of slabs) {
    if (remaining <= 0) break;
    const cap = slab.max_units !== null
      ? slab.max_units - slab.min_units + (slab.min_units === 0 ? 0 : 1)
      : Infinity;
    const used = Math.min(remaining, cap);
    energy += used * Number(slab.rate_per_kwh);
    remaining -= used;
  }
  const fixed = Number(slabs[0].fixed_charge_monthly) * sanctionedLoad;
  const duty = energy * (Number(slabs[0].duty_tax_percentage) / 100);
  return { energy, fixed, duty, total: energy + fixed + duty };
}

// -------------------------------------------------------------
// Theme
// -------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem('urja_theme', theme); } catch { /* ignore */ }
}

// -------------------------------------------------------------
// Navigation
// -------------------------------------------------------------
function switchScreen(screenId, updateHash = true) {
  if (!$(screenId)) screenId = 'screen-dashboard';
  state.activeScreen = screenId;

  document.querySelectorAll('.screen-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach((t) => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });

  $(screenId).classList.add('active');
  const tab = document.querySelector(`.nav-tab[data-screen="${screenId}"]`);
  if (tab) {
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  if (updateHash) history.replaceState(null, '', `#${screenId.replace('screen-', '')}`);
  if (screenId === 'screen-simulator') {
    populateSimulatorApplianceDropdown();
    runROI();
  }
  if (screenId === 'screen-solar') initSolar();
  window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
}

// -------------------------------------------------------------
// Initialization & data loading
// -------------------------------------------------------------
async function initApp() {
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  // Older versions saved a session id in the browser. Remove it so nothing is reused.
  try { localStorage.removeItem('urja_session_id'); } catch { /* ignore */ }

  buildPresetList();
  buildQuickChips();
  setupEventListeners();

  const hash = location.hash.replace('#', '');
  if (hash) switchScreen(`screen-${hash}`, false);

  try {
    await createNewSession(false, false); // always a fresh, empty session
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, 'error');
  } finally {
    document.body.classList.remove('is-loading');
  }
}

async function createNewSession(announce = true, withSample = false) {
  const data = await api('/api/session/init', {
    method: 'POST',
    body: JSON.stringify({
      property_name: 'Household (Bihar)',
      property_type: 'Household',
      state_region: 'Bihar',
      sanctioned_load_kw: 2.0,
      with_sample: withSample
    })
  });
  state.sessionId = data.sessionId; // memory only, gone on refresh
  state.roiTariffSeeded = false;
  state.solar = null;
  state.solarUnitsTouched = false;
  await refreshAllData();
  if (announce) toast(withSample ? 'Sample household loaded' : 'Started a new empty audit');
}

async function refreshAllData() {
  if (!state.sessionId) return;
  setLoading(true);
  try {
    const id = state.sessionId;
    const [summary, appliances, bill, tariffs] = await Promise.all([
      api(`/api/audit-summary/${id}`),
      api(`/api/appliances/${id}`),
      api(`/api/bill/${id}`),
      api('/api/tariffs')
    ]);
    state.summary = summary;
    state.appliances = appliances;
    state.bill = bill;
    state.tariffs = tariffs;
    renderAll();
  } finally {
    setLoading(false);
  }
}

function renderAll() {
  renderHeader();
  renderDashboard();
  renderBillForm();
  renderTariffBreakdown();
  renderAppliancesTable();
  renderFeatures();            // bill check + history (features.js)
  renderReport();
  if (state.activeScreen === 'screen-simulator') populateSimulatorApplianceDropdown();
  if (state.activeScreen === 'screen-solar') initSolar();
  if (!state.roiTariffSeeded && state.summary?.metrics?.marginalRate) {
    $('roi-tariff').value = state.summary.metrics.marginalRate;
    state.roiTariffSeeded = true;
  }
}

function renderHeader() {
  if (state.summary?.session) {
    $('session-property-name').textContent = state.summary.session.property_name;
  }
}

// -------------------------------------------------------------
// Efficiency score
// -------------------------------------------------------------
function computeScore(m, recs, hasBill) {
  const rate = m.marginalRate || 8;
  const calcCost = m.totalCalculatedMonthlyKwh * rate;

  const upgradeSavings = recs
    .filter((r) => r.id !== 'REC_PHANTOM_DRAIN')
    .reduce((s, r) => s + r.estimatedMonthlySavings, 0);
  const savingsShare = calcCost > 0 ? Math.min(1, upgradeSavings / calcCost) : 0;
  const upgradePenalty = Math.min(40, savingsShare * 80);

  let drainPenalty = 0;
  let overPenalty = 0;
  if (hasBill && m.actualUnitsKwh > 0) {
    drainPenalty = Math.min(25, (m.unaccountedUnits / m.actualUnitsKwh) * 100 * 0.8);
    if (m.totalCalculatedMonthlyKwh > m.actualUnitsKwh * 1.15) overPenalty = 10;
  }

  const score = Math.max(0, Math.round(100 - upgradePenalty - drainPenalty - overPenalty));

  let label, tone;
  if (score >= 80) { label = 'Excellent — very efficient'; tone = 'great'; }
  else if (score >= 60) { label = 'Good — a few easy wins'; tone = 'good'; }
  else if (score >= 40) { label = 'Room to improve'; tone = 'fair'; }
  else { label = 'High savings potential'; tone = 'low'; }

  const top = [...recs].sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings)[0];
  let detail;
  if (top && m.totalPotentialSavingsMonthly > 0) {
    detail = `You could save about ${inr(m.totalPotentialSavingsMonthly, 0)} a month. Biggest opportunity: ${top.title}.`;
  } else {
    detail = 'No major waste detected in your appliance list. Keep it up!';
  }
  if (!hasBill) detail += ' Add your bill to check how well your list matches your meter.';

  return { score, label, tone, detail };
}

// -------------------------------------------------------------
// Screen 1: Dashboard
// -------------------------------------------------------------
function renderDashboard() {
  if (!state.summary || !state.summary.metrics) return;
  const m = state.summary.metrics;
  const hasBill = !!state.bill;
  const recs = state.summary.recommendations || [];
  const empty = state.appliances.length === 0;

  $('onboarding').hidden = !empty;
  $('dash-content').hidden = empty;
  if (empty) return;

  renderHero(m, recs, hasBill);

  animateText($('kpi-calc-kwh'), m.totalCalculatedMonthlyKwh, (v) => num(v, 1));
  $('kpi-calc-daily').textContent = `${num(m.totalCalculatedDailyKwh, 2)} kWh/day`;

  animateText($('kpi-bill-kwh'), hasBill ? m.actualUnitsKwh : 0, (v) => num(v, 1));
  $('kpi-bill-cost').textContent = hasBill ? inr(m.actualBillAmount) : 'Not entered';

  animateText($('kpi-drain-kwh'), m.unaccountedUnits, (v) => num(v, 1));
  $('kpi-drain-cost').textContent = `${inr(m.unaccountedCost)}/mo`;
  const badge = $('kpi-drain-badge');
  if (!hasBill) {
    badge.textContent = 'No bill yet';
    badge.className = 'kpi-badge badge-neutral';
  } else {
    badge.textContent = m.unaccountedUnits > 0 ? 'Standby Loss' : 'Matched';
    badge.className = `kpi-badge ${m.unaccountedUnits > 0 ? 'badge-warning' : 'badge-success'}`;
  }

  animateText($('kpi-savings-cost'), m.totalPotentialSavingsMonthly, (v) => num(v, 2));
  $('kpi-savings-annual').textContent = `${inr(m.totalPotentialSavingsMonthly * 12)}/yr`;

  renderReconciliation(m, hasBill);
  renderCarbon(m);

  const topList = $('top-appliances-list');
  topList.innerHTML = '';
  (state.summary.applianceBreakdown || []).slice(0, 5).forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'top-app-item';
    item.innerHTML = `
      <div class="top-app-meta">
        <span>${catIcon(a.category)} ${esc(a.appliance_name)} (${esc(a.quantity)}× @ ${esc(a.wattage)}W)</span>
        <span>${num(a.monthlyKwh, 1)} kWh · ${num(a.percentageShare, 1)}%</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width:${Math.min(100, a.percentageShare)}%;animation-delay:${i * 80}ms"></div>
      </div>`;
    topList.appendChild(item);
  });

  const categoryData = (state.summary.categoryBreakdown || []).map((c) => ({ label: c.category, value: c.monthlyKwh }));
  renderDonutChart('category-chart-container', categoryData, {
    centerValue: num(m.totalCalculatedMonthlyKwh, 0),
    centerLabel: 'kWh / month'
  });

  const legend = $('category-legend');
  legend.innerHTML = '';
  const visibleCats = categoryData.filter((c) => c.value > 0);
  const totalKwh = visibleCats.reduce((s, c) => s + c.value, 0);
  visibleCats.forEach((cat, idx) => {
    const pct = totalKwh > 0 ? (cat.value / totalKwh) * 100 : 0;
    const row = document.createElement('div');
    row.className = 'legend-item';
    row.innerHTML = `
      <div><span class="legend-color-dot" style="background-color:${CHART_COLORS[idx % CHART_COLORS.length]}"></span><strong>${catIcon(cat.label)} ${esc(cat.label)}</strong></div>
      <span>${num(cat.value, 1)} kWh <span class="muted">(${num(pct, 0)}%)</span></span>`;
    legend.appendChild(row);
  });

  renderSlabLadder(m, hasBill);
  renderProjection(recs);
  renderWhatIf();
  renderRecommendationsList('dashboard-recommendations-list', recs, state.appliances.length);
}

function renderHero(m, recs, hasBill) {
  const r = computeScore(m, recs, hasBill);
  $('hero').dataset.tone = r.tone;
  $('score-label').textContent = r.label;
  $('score-detail').textContent = r.detail;
  renderGauge('score-gauge', r.score);

  const co2 = m.totalCalculatedMonthlyKwh * CO2_PER_KWH;
  const chips = [
    `⚡ ${num(m.totalCalculatedMonthlyKwh, 0)} kWh / month`,
    `💰 Save up to ${inr(m.totalPotentialSavingsMonthly, 0)} / month`,
    `🌿 ${num(co2, 0)} kg CO₂ / month`,
    `📈 Marginal rate ${inr(m.marginalRate, 2)} / kWh`
  ];
  $('hero-chips').innerHTML = chips.map((c) => `<span class="hero-chip">${c}</span>`).join('');
}

function renderReconciliation(m, hasBill) {
  if (!hasBill || m.actualUnitsKwh <= 0) {
    $('recon-accounted').style.width = '0%';
    $('recon-drain').style.width = '0%';
    $('recon-text').textContent = 'Enter your billed units on the Bill & History tab to see how well your appliance list matches your meter.';
    return;
  }

  const total = Math.max(m.actualUnitsKwh, m.totalCalculatedMonthlyKwh, 0.0001);
  const accounted = Math.min(m.actualUnitsKwh, m.totalCalculatedMonthlyKwh);
  const accPct = (accounted / total) * 100;
  const drainPct = (m.unaccountedUnits / total) * 100;

  $('recon-accounted').style.width = `${accPct}%`;
  $('recon-drain').style.width = `${drainPct}%`;

  let text;
  if (m.unaccountedUnits > 0) {
    text = `Your appliances explain ${num(accPct, 0)}% of the ${num(m.actualUnitsKwh, 1)} kWh on your bill. ${num(m.unaccountedUnits, 1)} kWh (${inr(m.unaccountedCost)}/month) is unexplained — check for missing appliances or standby loads.`;
  } else if (m.totalCalculatedMonthlyKwh > m.actualUnitsKwh * 1.05) {
    text = `Your inventory (${num(m.totalCalculatedMonthlyKwh, 1)} kWh) is higher than your bill (${num(m.actualUnitsKwh, 1)} kWh). Check that wattage and daily hours are not overstated.`;
  } else {
    text = 'Your appliance inventory closely matches your metered consumption. Nice and accurate.';
  }
  $('recon-text').textContent = text;
}

function renderCarbon(m) {
  const co2Month = m.totalCalculatedMonthlyKwh * CO2_PER_KWH;
  animateText($('co2-month'), co2Month, (v) => num(v, 1));
  $('co2-year').textContent = `≈ ${num(co2Month * 12, 0)} kg per year`;

  const rate = m.marginalRate || 8;
  const savedKg = rate > 0 ? (m.totalPotentialSavingsMonthly / rate) * 12 * CO2_PER_KWH : 0;
  const trees = savedKg / KG_CO2_PER_TREE_YEAR;

  $('carbon-trees').textContent = trees >= 0.5
    ? '🌳'.repeat(Math.min(12, Math.round(trees)))
    : (savedKg > 0 ? '🌱' : '');

  $('carbon-note').textContent = savedKg > 0
    ? `Following the tips could avoid about ${num(savedKg, 0)} kg of CO₂ a year, like planting ${num(trees, 1)} trees.`
    : 'Add your appliances and bill to see how much CO₂ your savings could avoid.';
}

function renderSlabLadder(m, hasBill) {
  const box = $('slab-ladder');
  const msg = $('slab-message');
  const slabs = state.tariffs || [];

  if (!slabs.length) {
    box.innerHTML = '<div class="empty-state">Tariff slabs are not available.</div>';
    msg.textContent = '';
    return;
  }

  const useBill = hasBill && m.actualUnitsKwh > 0;
  const units = useBill ? m.actualUnitsKwh : m.totalCalculatedMonthlyKwh;

  const segStart = (s) => (Number(s.min_units) === 0 ? 0 : Number(s.min_units) - 1);
  const OPEN_EXTRA = 100;
  const last = slabs[slabs.length - 1];
  const segEnd = (s) => (s.max_units !== null ? Number(s.max_units) : segStart(s) + OPEN_EXTRA);
  const total = segEnd(last);

  let currentIdx = slabs.findIndex((s) => units <= segEnd(s));
  if (currentIdx === -1) currentIdx = slabs.length - 1;

  const colorFor = (i) => SLAB_COLORS[Math.round((i / Math.max(1, slabs.length - 1)) * (SLAB_COLORS.length - 1))];

  const segHtml = slabs.map((s, i) => {
    const width = ((segEnd(s) - segStart(s)) / total) * 100;
    const range = s.max_units !== null ? `${segStart(s)}–${s.max_units}` : `${segStart(s)}+`;
    return `
      <div class="ladder-seg ${i === currentIdx ? 'is-current' : ''}" style="width:${width}%;background:${colorFor(i)};animation-delay:${i * 90}ms" title="${esc(range)} units at ${inr(s.rate_per_kwh)} per unit">
        <span class="rate">${inr(s.rate_per_kwh)}</span>
        <span class="range">${esc(range)}</span>
      </div>`;
  }).join('');

  const markerPct = Math.max(2, Math.min(98, (units / total) * 100));
  box.innerHTML = `
    <div class="ladder-wrap">
      <div class="ladder-marker" style="left:${markerPct}%"><span>${num(units, 0)} kWh</span></div>
      <div class="ladder">${segHtml}</div>
    </div>`;

  const basis = useBill ? 'from your bill' : 'from your appliance list';
  const cur = slabs[currentIdx];
  const next = slabs[currentIdx + 1];
  if (next) {
    const gap = Math.max(0, segEnd(cur) - units);
    msg.textContent = `You are using ${num(units, 0)} units a month (${basis}). About ${num(gap, 0)} more units would push you into the ${inr(next.rate_per_kwh)} slab, so each extra unit would cost ${inr(Number(next.rate_per_kwh) - Number(cur.rate_per_kwh))} more.`;
  } else {
    msg.textContent = `You are using ${num(units, 0)} units a month (${basis}), in the top slab. Every extra unit costs ${inr(cur.rate_per_kwh)}, so cutting usage saves the most here.`;
  }
}

function renderProjection(recs) {
  const note = $('projection-note');
  const monthly = recs.reduce((s, r) => s + r.estimatedMonthlySavings, 0);

  if (monthly <= 0) {
    $('projection-chart').innerHTML = '<div class="empty-state"><span class="big">📈</span>No savings to project yet</div>';
    note.textContent = '';
    return;
  }

  const capital = Math.round(recs.reduce((s, r) => (
    s + (r.estimatedPaybackMonths ? r.estimatedPaybackMonths * r.estimatedMonthlySavings : 0)
  ), 0));

  const points = Array.from({ length: 13 }, (_, i) => ({ x: i, y: monthly * i - capital }));
  const breakEven = capital > 0 ? capital / monthly : 0;

  renderLineChart('projection-chart', points, {
    breakEven: breakEven > 0 && breakEven <= 12 ? breakEven : null,
    yFormat: (v) => `${v < 0 ? '−' : ''}₹${compact(Math.abs(v))}`
  });

  if (capital <= 0) {
    note.textContent = `No upfront cost needed. About ${inr(monthly * 12, 0)} could be saved over 12 months.`;
  } else if (breakEven <= 12) {
    note.textContent = `Upgrades cost about ${inr(capital, 0)} upfront. You break even in roughly ${num(breakEven, 1)} months and are about ${inr(points[12].y, 0)} ahead after a year.`;
  } else {
    note.textContent = `Upgrades cost about ${inr(capital, 0)} upfront and take roughly ${num(breakEven, 1)} months to pay back, which is beyond this 12-month view.`;
  }
}

function renderWhatIf() {
  const m = state.summary?.metrics;
  if (!m) return;
  const pct = Number($('whatif-slider').value);
  const kwh = m.totalCalculatedMonthlyKwh * (pct / 100);
  const rate = m.marginalRate || 8;
  $('whatif-pct').textContent = pct;
  $('whatif-kwh').textContent = `${num(kwh, 1)} kWh`;
  $('whatif-month').textContent = inr(kwh * rate, 0);
  $('whatif-year').textContent = inr(kwh * rate * 12, 0);
  $('whatif-co2').textContent = `${num(kwh * 12 * CO2_PER_KWH, 0)} kg`;
}

function renderRecommendationsList(containerId, recs, applianceCount = 1) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!recs.length) {
    container.innerHTML = applianceCount === 0
      ? '<div class="empty-state"><span class="big">📝</span>Add your appliances on the Appliance Inventory tab to get personalised savings tips.</div>'
      : '<div class="empty-state"><span class="big">🎉</span>No immediate issues detected. Your usage matches expected load.</div>';
    return;
  }

  recs.forEach((rec) => {
    const payback = rec.estimatedPaybackMonths
      ? `<span class="rec-priority">PAYBACK ~${num(rec.estimatedPaybackMonths, 1)} MO</span>` : '';
    const card = document.createElement('div');
    card.className = `rec-card rec-${esc(rec.priority)}`;
    card.innerHTML = `
      <div class="rec-card-header">
        <div class="rec-title-wrap">
          <span class="rec-title">${esc(rec.title)}</span>
          <span style="display:flex;gap:.4rem;flex-wrap:wrap">
            <span class="rec-priority ${esc(rec.priority)}">${esc(rec.priority)}</span>
            <span class="rec-priority">${esc(rec.category)}</span>
            ${payback}
          </span>
        </div>
        <span class="rec-savings-pill">Save ${inr(rec.estimatedMonthlySavings)}/mo</span>
      </div>
      <p class="rec-desc">${esc(rec.description)}</p>
      <div class="rec-reason"><strong>Why:</strong> ${esc(rec.reason)}</div>
      <ul class="rec-actions-list">${(rec.actionItems || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
    container.appendChild(card);
  });
}

// -------------------------------------------------------------
// Screen 2: Bill form & tariff breakdown (bill check/history: features.js)
// -------------------------------------------------------------
function renderBillForm() {
  const session = state.summary?.session;
  if (session) {
    $('bill-property').value = session.property_name;
    $('sanctioned-load').value = session.sanctioned_load_kw;
  }
  if (state.bill) {
    $('actual-units').value = state.bill.actual_units_kwh;
    $('actual-amount').value = state.bill.actual_bill_amount;
    $('bill-month').value = state.bill.billing_month || 'Current Month';
  } else {
    $('actual-units').value = '';
    $('actual-amount').value = '';
    $('bill-month').value = 'Current Month';
  }
  updateBillPreview();
}

function updateBillPreview() {
  const box = $('bill-preview');
  const unitsRaw = $('actual-units').value;
  const units = Number(unitsRaw);
  const amount = Number($('actual-amount').value);
  const load = Number($('sanctioned-load').value) || 0;
  const est = estimateBill(units, state.tariffs, load);

  if (!est || unitsRaw === '' || !Number.isFinite(units)) {
    box.innerHTML = '<span>Enter the units from your bill to preview the estimated amount.</span>';
    return;
  }

  const hasAmount = $('actual-amount').value !== '';
  const diff = amount - est.total;
  const close = Math.abs(diff) <= est.total * 0.05;
  const diffClass = close ? 'diff-ok' : 'diff-warn';
  const diffText = !hasAmount
    ? 'Enter your billed amount to compare'
    : close
      ? 'Matches the slab estimate'
      : diff > 0 ? `${inr(diff)} above estimate (arrears, surcharges or meter rent?)` : `${inr(-diff)} below estimate`;

  box.innerHTML = `
    <div class="row"><span>Estimated bill for ${num(units, 1)} kWh</span><strong>${inr(est.total)}</strong></div>
    <div class="row"><span>Energy · Fixed · Duty</span><span>${inr(est.energy)} · ${inr(est.fixed)} · ${inr(est.duty)}</span></div>
    <div class="row"><span>Your entered amount</span><span class="${hasAmount ? diffClass : ''}">${esc(diffText)}</span></div>`;
}

function renderTariffBreakdown() {
  if (!state.summary || !state.summary.tariffDetails) return;
  const t = state.summary.tariffDetails;
  const tbody = $('tariff-slabs-tbody');
  tbody.innerHTML = '';

  const slabs = t.slabBreakdown || [];
  if (!slabs.length) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">Add appliances to see how the tariff slabs apply.</div></td></tr>';
  }
  slabs.forEach((slab, i) => {
    const tr = document.createElement('tr');
    if (i === slabs.length - 1) tr.className = 'slab-active';
    tr.innerHTML = `
      <td><strong>${esc(slab.range)}</strong></td>
      <td>${inr(slab.rate)}</td>
      <td>${num(slab.units, 1)} kWh</td>
      <td>${inr(slab.cost)}</td>`;
    tbody.appendChild(tr);
  });

  $('tariff-summary-box').innerHTML = `
    <div class="summary-row"><span>Energy Charges Subtotal:</span><strong>${inr(t.energyCharges)}</strong></div>
    <div class="summary-row"><span>Fixed Monthly Meter Charges:</span><strong>${inr(t.fixedCharges)}</strong></div>
    <div class="summary-row"><span>Electricity Duty & Surcharge:</span><strong>${inr(t.electricityDuty)}</strong></div>
    <div class="summary-row total-row"><span>Total Estimated Bill:</span><span>${inr(t.totalEstimatedBill)}</span></div>`;
}

// -------------------------------------------------------------
// Screen 3: Appliances
// -------------------------------------------------------------
function buildPresetList() {
  $('appliance-presets').innerHTML = PRESETS.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
}

function buildQuickChips() {
  $('quick-chips').innerHTML = PRESETS.map((p, i) => (
    `<button type="button" class="chip" data-preset="${i}">${catIcon(p.category)} ${esc(p.name.split(' (')[0])}</button>`
  )).join('');
}

function getVisibleAppliances() {
  const { q, category, sort } = state.filters;
  let list = state.appliances.filter((a) => {
    const matchQ = !q || a.appliance_name.toLowerCase().includes(q.toLowerCase());
    const matchC = !category || a.category === category;
    return matchQ && matchC;
  });

  const sorters = {
    'kwh-desc': (a, b) => b.monthlyKwh - a.monthlyKwh,
    'kwh-asc': (a, b) => a.monthlyKwh - b.monthlyKwh,
    name: (a, b) => a.appliance_name.localeCompare(b.appliance_name),
    category: (a, b) => a.category.localeCompare(b.category) || b.monthlyKwh - a.monthlyKwh
  };
  if (sorters[sort]) list = [...list].sort(sorters[sort]);
  return list;
}

function renderAppliancesTable() {
  const tbody = $('appliances-tbody');
  const tfoot = $('appliances-tfoot');
  tbody.innerHTML = '';

  const marginalRate = state.summary?.metrics?.marginalRate || 8.0;
  const totalAll = state.summary?.metrics?.totalCalculatedMonthlyKwh || 0;
  const visible = getVisibleAppliances();

  $('appliances-count').textContent = `${visible.length} of ${state.appliances.length} shown`;

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><span class="big">🔎</span>${
      state.appliances.length ? 'No appliances match your filters.' : 'Your list is empty. Add your first appliance above, or tap a quick-add chip.'
    }</div></td></tr>`;
    tfoot.innerHTML = '';
    return;
  }

  let visibleKwh = 0;
  visible.forEach((a) => {
    visibleKwh += a.monthlyKwh;
    const share = totalAll > 0 ? (a.monthlyKwh / totalAll) * 100 : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(a.appliance_name)}</strong></td>
      <td><span class="panel-tag cat-pill">${catIcon(a.category)} ${esc(a.category)}</span></td>
      <td>${esc(a.quantity)}</td>
      <td>${num(a.wattage, 0)} W</td>
      <td>${num(a.daily_hours, 1)} hrs/day</td>
      <td>${num(a.totalDailyKwh, 2)} kWh</td>
      <td><strong>${num(a.monthlyKwh, 1)} kWh</strong></td>
      <td>${num(share, 1)}%</td>
      <td>${inr(a.monthlyKwh * marginalRate)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-ghost" data-action="edit" data-id="${a.id}" aria-label="Edit ${esc(a.appliance_name)}">✏️ Edit</button>
          <button class="btn btn-danger" data-action="delete" data-id="${a.id}" aria-label="Delete ${esc(a.appliance_name)}">🗑 Delete</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  const filtered = visible.length !== state.appliances.length;
  tfoot.innerHTML = `
    <tr>
      <td colspan="6"><strong>${filtered ? 'Total of shown appliances' : 'Total Calculated Inventory Load'}</strong></td>
      <td><strong>${num(visibleKwh, 1)} kWh</strong></td>
      <td>${num(totalAll > 0 ? (visibleKwh / totalAll) * 100 : 0, 0)}%</td>
      <td><strong>${inr(visibleKwh * marginalRate)}</strong></td>
      <td></td>
    </tr>`;
}

function openEditDialog(id) {
  const a = state.appliances.find((x) => x.id === id);
  if (!a) return;
  $('edit-id').value = a.id;
  $('edit-name').value = a.appliance_name;
  $('edit-category').value = a.category;
  $('edit-qty').value = a.quantity;
  $('edit-wattage').value = a.wattage;
  $('edit-hours').value = a.daily_hours;
  $('dialog-edit').showModal();
  $('edit-name').focus();
}

function exportAppliancesCSV() {
  if (!state.appliances.length) return toast('Add some appliances before exporting', 'info');
  const marginalRate = state.summary?.metrics?.marginalRate || 8.0;
  const rows = [['Appliance', 'Category', 'Quantity', 'Power (W)', 'Hours/day', 'Daily kWh', 'Monthly kWh', 'Est. monthly cost (INR)']];
  state.appliances.forEach((a) => rows.push([
    a.appliance_name, a.category, a.quantity, a.wattage, a.daily_hours,
    a.totalDailyKwh, a.monthlyKwh, (a.monthlyKwh * marginalRate).toFixed(2)
  ]));
  downloadCSV('urjaaudit-appliances.csv', rows);
  toast('Appliance list exported');
}

// -------------------------------------------------------------
// Screen 4: Simulator & ROI
// -------------------------------------------------------------
function populateSimulatorApplianceDropdown() {
  const select = $('sim-appliance-select');
  const previous = Number(select.value);
  select.innerHTML = '';

  if (!state.appliances.length) {
    select.innerHTML = '<option value="">Add appliances first</option>';
    triggerUsageSimulation();
    return;
  }

  state.appliances.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.appliance_name} (${a.quantity}× @ ${a.wattage}W, ${a.daily_hours} hrs/day)`;
    select.appendChild(opt);
  });

  if (previous && state.appliances.some((a) => a.id === previous)) {
    select.value = previous;
  } else {
    resetSimulatorSlider();
  }
  triggerUsageSimulation();
}

function resetSimulatorSlider() {
  const a = state.appliances.find((x) => x.id === Number($('sim-appliance-select').value));
  if (a) $('sim-hours-slider').value = Math.max(0, Number(a.daily_hours) - 2);
}

function triggerUsageSimulation() {
  const a = state.appliances.find((x) => x.id === Number($('sim-appliance-select').value));
  const marginalRate = state.summary?.metrics?.marginalRate || 8.0;

  if (!a) {
    ['sim-res-orig-kwh', 'sim-res-new-kwh', 'sim-res-saved-kwh'].forEach((id) => { $(id).textContent = '0 kWh'; });
    ['sim-res-orig-cost', 'sim-res-new-cost', 'sim-res-saved-cost'].forEach((id) => { $(id).textContent = '₹0 / month'; });
    $('sim-orig-hours').textContent = '0';
    $('sim-new-hours-val').textContent = '0';
    $('sim-annual').textContent = '₹0.00';
    return;
  }

  const origHours = Number(a.daily_hours);
  const newHours = Number($('sim-hours-slider').value);
  const perHourKwh = (a.wattage * a.quantity * 30) / 1000;
  const origKwh = perHourKwh * origHours;
  const newKwh = perHourKwh * newHours;
  const savedKwh = Math.max(0, origKwh - newKwh);

  $('sim-orig-hours').textContent = num(origHours, 1);
  $('sim-new-hours-val').textContent = num(newHours, 1);
  $('sim-res-orig-kwh').textContent = `${num(origKwh, 1)} kWh`;
  $('sim-res-orig-cost').textContent = `${inr(origKwh * marginalRate)} / month`;
  $('sim-res-new-kwh').textContent = `${num(newKwh, 1)} kWh`;
  $('sim-res-new-cost').textContent = `${inr(newKwh * marginalRate)} / month`;
  $('sim-res-saved-kwh').textContent = `${num(savedKwh, 1)} kWh`;
  $('sim-res-saved-cost').textContent = `${inr(savedKwh * marginalRate)} / month`;
  $('sim-annual').textContent = inr(savedKwh * marginalRate * 12);
}

async function runROI() {
  const payload = {
    existingWattage: $('roi-old-w').value,
    newWattage: $('roi-new-w').value,
    quantity: $('roi-qty').value,
    dailyHours: $('roi-hours').value,
    capitalCost: $('roi-cost').value,
    tariffRate: $('roi-tariff').value
  };
  if (Object.values(payload).some((v) => v === '' || Number(v) < 0)) return;

  try {
    const data = await api('/api/simulator/calculate', { method: 'POST', body: JSON.stringify(payload) });
    $('roi-res-energy').textContent = `${num(data.unitsSavedMonthly, 1)} kWh`;
    $('roi-res-savings').textContent = inr(data.monthlySavingsInr);
    $('roi-res-payback').textContent = data.monthlySavingsInr > 0
      ? (data.paybackMonths >= 24 ? `${num(data.paybackYears, 1)} Years` : `${num(data.paybackMonths, 1)} Months`)
      : 'No savings';
    $('roi-res-annual').textContent = inr(data.annualSavingsInr);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// Screen 6: Report
// -------------------------------------------------------------
function renderReport() {
  if (!state.summary) return;
  const m = state.summary.metrics;
  const session = state.summary.session;
  const hasBill = !!state.bill;

  $('report-property').textContent = `${session.property_name} · Electricity Savings & Energy Efficiency Audit`;
  $('report-load').textContent = num(session.sanctioned_load_kw, 1);
  $('report-date-string').textContent = `Date: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  $('rep-actual-kwh').textContent = hasBill ? `${num(m.actualUnitsKwh, 1)} kWh` : '—';
  $('rep-actual-cost').textContent = hasBill ? inr(m.actualBillAmount) : 'Bill not entered';
  $('rep-calc-kwh').textContent = `${num(m.totalCalculatedMonthlyKwh, 1)} kWh`;
  $('rep-calc-cost').textContent = inr(m.estimatedCalculatedBill);
  $('rep-drain-kwh').textContent = `${num(m.unaccountedUnits, 1)} kWh`;
  $('rep-drain-cost').textContent = `${inr(m.unaccountedCost)}/mo`;
  $('rep-savings-kwh').textContent = inr(m.totalPotentialSavingsMonthly);

  const tbody = $('report-appliances-tbody');
  tbody.innerHTML = '';
  const marginalRate = m.marginalRate || 8.0;
  if (!state.appliances.length) {
    tbody.innerHTML = '<tr><td colspan="8">No appliances added yet.</td></tr>';
  }
  state.appliances.forEach((a) => {
    const share = m.totalCalculatedMonthlyKwh > 0 ? (a.monthlyKwh / m.totalCalculatedMonthlyKwh) * 100 : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(a.appliance_name)}</strong></td>
      <td>${esc(a.category)}</td>
      <td>${esc(a.quantity)}</td>
      <td>${num(a.wattage, 0)}W</td>
      <td>${num(a.daily_hours, 1)} hrs</td>
      <td>${num(a.monthlyKwh, 1)} kWh</td>
      <td>${num(share, 1)}%</td>
      <td>${inr(a.monthlyKwh * marginalRate)}</td>`;
    tbody.appendChild(tr);
  });

  const recContainer = $('report-recommendations-list');
  recContainer.innerHTML = '';
  const recs = state.summary.recommendations || [];
  if (!recs.length) recContainer.innerHTML = '<p class="rec-desc">No action items yet. Add appliances and your bill to generate recommendations.</p>';
  recs.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'report-rec-item';
    div.innerHTML = `
      <div class="report-rec-head">
        <strong>${esc(r.title)}</strong>
        <span class="success-text" style="font-weight:700">Est. savings: ${inr(r.estimatedMonthlySavings)}/mo</span>
      </div>
      <p class="report-rec-desc">${esc(r.description)}</p>
      <ul class="report-rec-actions">${(r.actionItems || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    recContainer.appendChild(div);
  });

  renderReportExtras(); // bill check, history and solar sections (features.js)
}

function exportReportCSV() {
  if (!state.summary) return;
  const m = state.summary.metrics;
  const hasBill = !!state.bill;
  const check = state.summary.billCheck;
  const rows = [
    ['UrjaAudit Summary'],
    ['Property', state.summary.session.property_name],
    ['Actual metered (kWh)', hasBill ? m.actualUnitsKwh : 'not entered'],
    ['Actual bill (INR)', hasBill ? m.actualBillAmount : 'not entered'],
    ['Calculated load (kWh)', m.totalCalculatedMonthlyKwh],
    ['Estimated bill from inventory (INR)', m.estimatedCalculatedBill],
    ['Unexplained drain (kWh)', m.unaccountedUnits],
    ['Potential monthly savings (INR)', m.totalPotentialSavingsMonthly],
    ['Bill check', check ? check.headline : 'no bill'],
    [],
    ['Bill history'],
    ['Month', 'Units (kWh)', 'Amount (INR)', 'Slab estimate (INR)'],
    ...((state.summary.billHistory?.points || []).map((p) => [p.label, p.units, p.amount, p.expectedAmount])),
    [],
    ['Recommendation', 'Priority', 'Est. monthly savings (INR)'],
    ...(state.summary.recommendations || []).map((r) => [r.title, r.priority, r.estimatedMonthlySavings])
  ];
  downloadCSV('urjaaudit-report.csv', rows);
  toast('Report exported');
}

// -------------------------------------------------------------
// Event handlers
// -------------------------------------------------------------
async function loadSampleData(skipConfirm = false) {
  if (!skipConfirm) {
    const message = state.appliances.length
      ? 'This replaces your current list with a sample Bihar household. Your current entries will no longer be shown.'
      : 'Load a sample Bihar household so you can see how the audit works?';
    const ok = await confirmDialog(message, 'Load sample');
    if (!ok) return;
  }
  try {
    await createNewSession(true, true);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setupEventListeners() {
  // Theme
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  // Tabs & internal links
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
  });
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => switchScreen(el.dataset.goto));
  });
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (h) switchScreen(`screen-${h}`, false);
  });

  // Dashboard
  $('btn-refresh-dashboard').addEventListener('click', async () => {
    try { await refreshAllData(); toast('Dashboard refreshed', 'info'); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('btn-onboard-sample').addEventListener('click', () => loadSampleData(true));
  $('whatif-slider').addEventListener('input', renderWhatIf);

  // Bill form
  ['actual-units', 'actual-amount', 'sanctioned-load'].forEach((id) => {
    $(id).addEventListener('input', updateBillPreview);
  });

  $('form-bill').addEventListener('submit', async (e) => {
    e.preventDefault();
    const units = Number($('actual-units').value);
    const amount = Number($('actual-amount').value);
    const load = Number($('sanctioned-load').value);
    const name = $('bill-property').value.trim();
    const month = $('bill-month').value.trim();

    if (!name) return toast('Please enter a property name', 'error');
    if (!month) return toast('Enter a billing month, for example "Dec 2026"', 'error');
    if (!(units >= 0) || $('actual-units').value === '') return toast('Enter a valid number of units', 'error');
    if (!(amount >= 0) || $('actual-amount').value === '') return toast('Enter a valid bill amount', 'error');
    if (!(load > 0)) return toast('Sanctioned load must be greater than 0', 'error');

    try {
      await api(`/api/session/${state.sessionId}`, {
        method: 'PUT',
        body: JSON.stringify({ property_name: name, sanctioned_load_kw: load })
      });
      const result = await api(`/api/bill/${state.sessionId}`, {
        method: 'POST',
        body: JSON.stringify({ billing_month: month, actual_units_kwh: units, actual_bill_amount: amount })
      });
      await refreshAllData();
      toast(result.updated ? `${month} bill updated` : `${month} bill added to your history`);
      // Stay on this tab so the person sees the verdict
      $('bill-check-card').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Quick-add chips
  $('quick-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn) return;
    const p = PRESETS[Number(btn.dataset.preset)];
    if (!p) return;
    $('app-name').value = p.name;
    $('app-category').value = p.category;
    $('app-wattage').value = p.wattage;
    $('app-hours').value = p.hours;
    $('app-qty').focus();
    $('app-qty').select();
    toast(`${p.name.split(' (')[0]} filled in. Set the quantity and press Add.`, 'info');
  });

  // Add appliance
  $('app-name').addEventListener('input', (e) => {
    const preset = PRESETS.find((p) => p.name === e.target.value);
    if (preset) {
      $('app-category').value = preset.category;
      $('app-wattage').value = preset.wattage;
      $('app-hours').value = preset.hours;
    }
  });

  $('form-add-appliance').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      appliance_name: $('app-name').value.trim(),
      category: $('app-category').value,
      quantity: Number($('app-qty').value),
      wattage: Number($('app-wattage').value),
      daily_hours: Number($('app-hours').value),
      days_per_month: 30
    };
    try {
      await api(`/api/appliances/${state.sessionId}`, { method: 'POST', body: JSON.stringify(payload) });
      $('form-add-appliance').reset();
      await refreshAllData();
      toast(`${payload.appliance_name} added`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Appliance filters
  $('app-search').addEventListener('input', debounce((e) => {
    state.filters.q = e.target.value.trim();
    renderAppliancesTable();
  }, 150));
  $('app-filter-category').addEventListener('change', (e) => { state.filters.category = e.target.value; renderAppliancesTable(); });
  $('app-sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; renderAppliancesTable(); });
  $('btn-export-appliances').addEventListener('click', exportAppliancesCSV);

  // Row actions (event delegation)
  $('appliances-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.action === 'edit') return openEditDialog(id);

    if (btn.dataset.action === 'delete') {
      const a = state.appliances.find((x) => x.id === id);
      const ok = await confirmDialog(`Remove "${a ? a.appliance_name : 'this appliance'}" from your inventory?`, 'Delete');
      if (!ok) return;
      try {
        await api(`/api/appliances/${state.sessionId}/${id}`, { method: 'DELETE' });
        await refreshAllData();
        toast('Appliance removed');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  // Edit dialog
  $('edit-cancel').addEventListener('click', () => $('dialog-edit').close());
  $('form-edit-appliance').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = Number($('edit-id').value);
    const original = state.appliances.find((x) => x.id === id);
    const payload = {
      appliance_name: $('edit-name').value.trim(),
      category: $('edit-category').value,
      quantity: Number($('edit-qty').value),
      wattage: Number($('edit-wattage').value),
      daily_hours: Number($('edit-hours').value),
      days_per_month: original ? original.days_per_month : 30
    };
    try {
      await api(`/api/appliances/${state.sessionId}/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      $('dialog-edit').close();
      await refreshAllData();
      toast('Appliance updated');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Load sample data
  $('btn-load-bihar-example').addEventListener('click', () => loadSampleData(false));

  // Simulator
  $('sim-appliance-select').addEventListener('change', () => {
    resetSimulatorSlider();
    triggerUsageSimulation();
  });
  $('sim-hours-slider').addEventListener('input', triggerUsageSimulation);
  $('btn-sim-reset').addEventListener('click', () => { resetSimulatorSlider(); triggerUsageSimulation(); });

  // ROI (button + live update)
  $('btn-run-roi').addEventListener('click', runROI);
  const liveROI = debounce(runROI, 300);
  ['roi-old-w', 'roi-new-w', 'roi-qty', 'roi-hours', 'roi-cost', 'roi-tariff'].forEach((id) => {
    $(id).addEventListener('input', liveROI);
  });

  // Report
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-export-report').addEventListener('click', exportReportCSV);

  // Bill check, history and solar planner (features.js)
  setupFeatureListeners();
}

document.addEventListener('DOMContentLoaded', initApp);