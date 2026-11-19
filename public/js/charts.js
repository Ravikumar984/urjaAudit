/**
 * UrjaAudit Lightweight Native SVG Visualization Engine
 * Donut chart, score gauge, line chart and bar chart. No external libraries.
 */

const CHART_COLORS = ['#059669', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Donut chart. Hovering a slice shows its value in the centre. */
function renderDonutChart(containerId, data, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const slices = (data || []).filter((d) => Number(d.value) > 0);
  const total = slices.reduce((sum, item) => sum + Number(item.value), 0);

  if (total === 0) {
    container.innerHTML = '<div class="empty-state"><span class="big">🔌</span>No load recorded</div>';
    return;
  }

  const defaultValue = opts.centerValue ?? total.toFixed(0);
  const defaultLabel = (opts.centerLabel ?? 'kWh / month').toUpperCase();

  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: '100%', height: '100%' });
  const value = svgEl('text', { x: 50, y: 51, 'text-anchor': 'middle', class: 'donut-value' }, defaultValue);
  const label = svgEl('text', { x: 50, y: 58, 'text-anchor': 'middle', class: 'donut-label' }, defaultLabel);

  let cumulativeAngle = 0;
  const polar = (deg) => [
    50 + 40 * Math.cos(Math.PI * (deg - 90) / 180),
    50 + 40 * Math.sin(Math.PI * (deg - 90) / 180)
  ];

  slices.forEach((slice, index) => {
    const fraction = slice.value / total;
    const angle = fraction * 360;
    const startAngle = cumulativeAngle;
    const endAngle = cumulativeAngle + angle;
    cumulativeAngle = endAngle;

    const [x1, y1] = polar(startAngle);
    const [x2, y2] = polar(endAngle);
    const largeArcFlag = angle > 180 ? 1 : 0;
    const d = fraction >= 0.999
      ? 'M 50 10 A 40 40 0 1 1 49.99 10 Z'
      : `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

    const path = svgEl('path', {
      d,
      fill: CHART_COLORS[index % CHART_COLORS.length],
      'stroke-width': 1.2,
      class: 'donut-slice'
    });
    path.style.animationDelay = `${index * 70}ms`;

    path.appendChild(svgEl('title', {},
      `${slice.label}: ${Number(slice.value).toFixed(1)} kWh (${((slice.value / total) * 100).toFixed(1)}%)`));

    path.addEventListener('mouseenter', () => {
      value.textContent = Number(slice.value).toFixed(1);
      label.textContent = String(slice.label).toUpperCase();
    });
    path.addEventListener('mouseleave', () => {
      value.textContent = defaultValue;
      label.textContent = defaultLabel;
    });

    svg.appendChild(path);
  });

  svg.appendChild(svgEl('circle', { cx: 50, cy: 50, r: 25, class: 'donut-hole' }));
  svg.appendChild(value);
  svg.appendChild(label);
  container.appendChild(svg);
}

/** Animated circular gauge (0-100). Pass null for "no score". */
function renderGauge(containerId, score) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const R = 42;
  const C = 2 * Math.PI * R;
  const hasScore = typeof score === 'number' && Number.isFinite(score);
  const target = hasScore ? Math.max(0, Math.min(100, score)) : 0;

  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: '100%', height: '100%' });
  svg.appendChild(svgEl('circle', { cx: 50, cy: 50, r: R, class: 'gauge-track' }));

  const progress = svgEl('circle', {
    cx: 50, cy: 50, r: R, class: 'gauge-progress',
    transform: 'rotate(-90 50 50)',
    'stroke-dasharray': C,
    'stroke-dashoffset': C
  });
  svg.appendChild(progress);

  const valueText = svgEl('text', { x: 50, y: 54, 'text-anchor': 'middle', class: 'gauge-value' }, hasScore ? '0' : '—');
  svg.appendChild(valueText);
  svg.appendChild(svgEl('text', { x: 50, y: 65, 'text-anchor': 'middle', class: 'gauge-sub' }, 'OUT OF 100'));
  container.appendChild(svg);

  if (!hasScore) return;

  const finalOffset = C * (1 - target / 100);
  if (prefersReducedMotion()) {
    progress.setAttribute('stroke-dashoffset', finalOffset);
    valueText.textContent = Math.round(target);
    return;
  }

  setTimeout(() => progress.setAttribute('stroke-dashoffset', finalOffset), 40);

  const duration = 1100;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    valueText.textContent = Math.round(target * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * pow;
}

/**
 * Line + area chart with a zero baseline and optional break-even marker.
 * opts: { yFormat, xTickEvery, xLabel, breakEven, breakEvenUnit }
 */
function renderLineChart(containerId, points, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!points || points.length < 2) {
    container.innerHTML = '<div class="empty-state"><span class="big">📈</span>Not enough data to chart yet</div>';
    return;
  }

  const yFormat = opts.yFormat || ((v) => String(Math.round(v)));
  const tickEvery = opts.xTickEvery || 2;
  const W = 420, H = 210, pl = 48, pr = 14, pt = 16, pb = 30;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(0, ...ys);
  let yMax = Math.max(0, ...ys);
  if (yMax === yMin) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08;
  yMax += pad;
  if (yMin < 0) yMin -= pad;

  const sx = (x) => pl + ((x - xMin) / (xMax - xMin)) * (W - pl - pr);
  const sy = (y) => pt + ((yMax - y) / (yMax - yMin)) * (H - pt - pb);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

  const gradId = `lc-grad-${containerId}`;
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  const stopA = svgEl('stop', { offset: '0%', 'stop-opacity': 0.35 });
  const stopB = svgEl('stop', { offset: '100%', 'stop-opacity': 0.02 });
  stopA.style.stopColor = 'var(--primary)';
  stopB.style.stopColor = 'var(--primary)';
  grad.appendChild(stopA);
  grad.appendChild(stopB);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const step = niceStep((yMax - yMin) / 4);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    const y = sy(v);
    svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: y, y2: y, class: Math.abs(v) < 1e-9 ? 'lc-zero' : 'lc-grid' }));
    svg.appendChild(svgEl('text', { x: pl - 6, y: y + 3, 'text-anchor': 'end', class: 'lc-axis' }, yFormat(v)));
  }

  points.forEach((p) => {
    if (p.x % tickEvery !== 0) return;
    svg.appendChild(svgEl('text', { x: sx(p.x), y: H - 10, 'text-anchor': 'middle', class: 'lc-axis' }, p.x));
  });
  svg.appendChild(svgEl('text', { x: (pl + W - pr) / 2, y: H - 0.5, 'text-anchor': 'middle', class: 'lc-axis' }, opts.xLabel || 'Months'));

  const zeroY = sy(0);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x)} ${sy(p.y)}`).join(' ');
  const areaPath = `${linePath} L ${sx(xMax)} ${zeroY} L ${sx(xMin)} ${zeroY} Z`;
  svg.appendChild(svgEl('path', { d: areaPath, fill: `url(#${gradId})` }));

  if (opts.breakEven != null && opts.breakEven >= xMin && opts.breakEven <= xMax) {
    const bx = sx(opts.breakEven);
    svg.appendChild(svgEl('line', { x1: bx, x2: bx, y1: pt, y2: H - pb, class: 'lc-be-line' }));
    const anchor = bx > W - 90 ? 'end' : 'start';
    svg.appendChild(svgEl('text', { x: anchor === 'end' ? bx - 4 : bx + 4, y: pt + 8, 'text-anchor': anchor, class: 'lc-be-label' },
      `Break-even ≈ ${opts.breakEven.toFixed(1)} ${opts.breakEvenUnit || 'mo'}`));
  }

  const line = svgEl('path', { d: linePath, class: 'lc-line' });
  svg.appendChild(line);

  // Dots are skipped on long series to keep the chart clean
  const showDots = points.length <= 16;
  points.forEach((p) => {
    const hit = svgEl('circle', { cx: sx(p.x), cy: sy(p.y), r: showDots ? 10 : 6, class: 'lc-hit' });
    hit.appendChild(svgEl('title', {}, `${opts.xLabel === 'Years' ? 'Year' : 'Month'} ${p.x}: ${yFormat(p.y)}`));
    svg.appendChild(hit);
    if (showDots) svg.appendChild(svgEl('circle', { cx: sx(p.x), cy: sy(p.y), r: 3, class: 'lc-dot' }));
  });

  container.appendChild(svg);

  if (!prefersReducedMotion() && typeof line.getTotalLength === 'function') {
    try {
      const len = line.getTotalLength();
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      line.getBoundingClientRect();
      line.style.transition = 'stroke-dashoffset 1.1s ease';
      requestAnimationFrame(() => { line.style.strokeDashoffset = 0; });
    } catch { /* ignore if the element is hidden */ }
  }
}

/**
 * Bar chart. bars: [{ label, value, flagged }]. opts: { yFormat, average, unitLabel }
 * Flagged bars are drawn in amber.
 */
function renderBarChart(containerId, bars, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!bars || !bars.length) {
    container.innerHTML = '<div class="empty-state"><span class="big">📊</span>No bills saved yet</div>';
    return;
  }

  const yFormat = opts.yFormat || ((v) => String(Math.round(v)));
  const W = 420, H = 210, pl = 44, pr = 12, pt = 22, pb = 34;

  const maxVal = Math.max(...bars.map((b) => b.value), opts.average || 0, 1);
  const yMax = maxVal * 1.15;
  const sy = (v) => pt + (1 - v / yMax) * (H - pt - pb);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

  const step = niceStep(yMax / 4);
  for (let v = 0; v <= yMax; v += step) {
    const y = sy(v);
    svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: y, y2: y, class: v === 0 ? 'lc-zero' : 'lc-grid' }));
    svg.appendChild(svgEl('text', { x: pl - 6, y: y + 3, 'text-anchor': 'end', class: 'lc-axis' }, yFormat(v)));
  }

  const slot = (W - pl - pr) / bars.length;
  const bw = Math.min(34, slot * 0.62);
  const labelEvery = bars.length > 8 ? 2 : 1;

  bars.forEach((b, i) => {
    const x = pl + slot * i + (slot - bw) / 2;
    const y = sy(b.value);
    const h = Math.max(0, sy(0) - y);

    const rect = svgEl('rect', { x, y, width: bw, height: h, rx: 3, class: `bc-bar${b.flagged ? ' flagged' : ''}` });
    rect.style.animationDelay = `${i * 50}ms`;
    rect.appendChild(svgEl('title', {}, `${b.label}: ${yFormat(b.value)}${opts.unitLabel ? ' ' + opts.unitLabel : ''}${b.flagged ? ' (unusual)' : ''}`));
    svg.appendChild(rect);

    if (bars.length <= 8) {
      svg.appendChild(svgEl('text', { x: x + bw / 2, y: y - 4, 'text-anchor': 'middle', class: 'bc-val' }, yFormat(b.value)));
    }
    if (i % labelEvery === 0) {
      svg.appendChild(svgEl('text', { x: x + bw / 2, y: H - 14, 'text-anchor': 'middle', class: 'lc-axis' }, b.label));
    }
  });

  if (opts.average > 0) {
    const ay = sy(opts.average);
    svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: ay, y2: ay, class: 'bc-avg' }));
    svg.appendChild(svgEl('text', { x: W - pr, y: ay - 4, 'text-anchor': 'end', class: 'bc-avg-label' }, `Avg ${yFormat(opts.average)}`));
  }

  container.appendChild(svg);
}