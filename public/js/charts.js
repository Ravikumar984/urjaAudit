/**
 * UrjaAudit Lightweight Native SVG Visualization Engine
 */

const CHART_COLORS = ['#059669', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];

/**
 * Renders a donut chart.
 * @param {string} containerId
 * @param {{label: string, value: number}[]} data
 * @param {{centerValue?: string, centerLabel?: string}} [opts]
 */
function renderDonutChart(containerId, data, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const slices = (data || []).filter(d => Number(d.value) > 0);
  const total = slices.reduce((sum, item) => sum + Number(item.value), 0);

  if (total === 0) {
    container.innerHTML = '<div class="empty-state"><span class="big">🔌</span>No load recorded</div>';
    return;
  }

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  let cumulativeAngle = 0;

  slices.forEach((slice, index) => {
    const fraction = slice.value / total;
    const angle = fraction * 360;
    const startAngle = cumulativeAngle;
    const endAngle = cumulativeAngle + angle;
    cumulativeAngle = endAngle;

    const polar = (deg) => [
      50 + 40 * Math.cos(Math.PI * (deg - 90) / 180),
      50 + 40 * Math.sin(Math.PI * (deg - 90) / 180)
    ];
    const [x1, y1] = polar(startAngle);
    const [x2, y2] = polar(endAngle);

    const largeArcFlag = angle > 180 ? 1 : 0;
    const pathData = fraction >= 0.999
      ? 'M 50 10 A 40 40 0 1 1 49.99 10 Z'
      : `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', CHART_COLORS[index % CHART_COLORS.length]);
    path.setAttribute('stroke', 'var(--surface)');
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('class', 'donut-slice');

    const title = document.createElementNS(NS, 'title');
    title.textContent = `${slice.label}: ${Number(slice.value).toFixed(1)} kWh (${((slice.value / total) * 100).toFixed(1)}%)`;
    path.appendChild(title);
    svg.appendChild(path);
  });

  // Donut hole
  const hole = document.createElementNS(NS, 'circle');
  hole.setAttribute('cx', '50');
  hole.setAttribute('cy', '50');
  hole.setAttribute('r', '25');
  hole.setAttribute('class', 'donut-hole');
  svg.appendChild(hole);

  // Center text
  const value = document.createElementNS(NS, 'text');
  value.setAttribute('x', '50');
  value.setAttribute('y', '51');
  value.setAttribute('text-anchor', 'middle');
  value.setAttribute('class', 'donut-value');
  value.textContent = opts.centerValue ?? total.toFixed(0);
  svg.appendChild(value);

  const label = document.createElementNS(NS, 'text');
  label.setAttribute('x', '50');
  label.setAttribute('y', '58');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('class', 'donut-label');
  label.textContent = (opts.centerLabel ?? 'kWh / MONTH').toUpperCase();
  svg.appendChild(label);

  container.appendChild(svg);
}