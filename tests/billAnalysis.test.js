const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateTariffCost } = require('../services/calculator');
const { checkBill, analyzeHistory } = require('../services/billAnalysis');

const slabs = [
  { min_units: 0, max_units: 50, rate_per_kwh: 6.10, fixed_charge_monthly: 40, duty_tax_percentage: 6 },
  { min_units: 51, max_units: 100, rate_per_kwh: 6.95, fixed_charge_monthly: 40, duty_tax_percentage: 6 },
  { min_units: 101, max_units: 200, rate_per_kwh: 8.05, fixed_charge_monthly: 60, duty_tax_percentage: 6 },
  { min_units: 201, max_units: 300, rate_per_kwh: 9.15, fixed_charge_monthly: 80, duty_tax_percentage: 6 },
  { min_units: 301, max_units: null, rate_per_kwh: 10.0, fixed_charge_monthly: 100, duty_tax_percentage: 6 }
];

const expected145 = calculateTariffCost(145, slabs, 2).totalEstimatedBill;

test('checkBill: matching bill is ok', () => {
  const r = checkBill({ units: 145, amount: expected145, slabs, sanctionedLoad: 2 });
  assert.equal(r.status, 'ok');
  assert.equal(r.reasons.length, 0);
});

test('checkBill: bill 10% over is slightly_high', () => {
  const r = checkBill({ units: 145, amount: expected145 * 1.1, slabs });
  assert.equal(r.status, 'slightly_high');
  assert.ok(r.reasons.length > 0);
});

test('checkBill: bill 30% over is high and gives next steps', () => {
  const r = checkBill({ units: 145, amount: expected145 * 1.3, slabs });
  assert.equal(r.status, 'high');
  assert.ok(r.nextSteps.length >= 3);
});

test('checkBill: bill 30% under is low', () => {
  const r = checkBill({ units: 145, amount: expected145 * 0.7, slabs });
  assert.equal(r.status, 'low');
});

test('checkBill: zero units gives unknown', () => {
  assert.equal(checkBill({ units: 0, amount: 100, slabs }).status, 'unknown');
});

test('checkBill: warns when appliances explain far fewer units than the bill', () => {
  const r = checkBill({ units: 200, amount: calculateTariffCost(200, slabs, 2).totalEstimatedBill, slabs, calculatedUnits: 100 });
  assert.ok(r.notes.length === 1);
});

const sample = [['Jun', 172], ['Jul', 186], ['Aug', 231], ['Sep', 178], ['Oct', 158], ['Nov', 145]].map(([m, u], i) => ({
  id: i + 1,
  billing_month: `${m} 2026`,
  actual_units_kwh: u,
  actual_bill_amount: Math.round(calculateTariffCost(u, slabs, 2).totalEstimatedBill)
}));

test('analyzeHistory: flags the August spike', () => {
  const h = analyzeHistory(sample, slabs, 2);
  assert.equal(h.count, 6);
  const aug = h.points.find((p) => p.label === 'Aug 2026');
  assert.ok(aug.flags.some((f) => f.type === 'spike'));
  assert.equal(h.flaggedCount, 1);
});

test('analyzeHistory: detects a falling trend and change from previous month', () => {
  const h = analyzeHistory(sample, slabs, 2);
  assert.equal(h.trend, 'falling');
  assert.ok(h.changeFromPrevious.percent < 0);
});

test('analyzeHistory: one month asks for more data', () => {
  const h = analyzeHistory([sample[0]], slabs, 2);
  assert.equal(h.trend, 'unknown');
  assert.ok(h.insights[0].includes('Add at least 2 months'));
});

test('analyzeHistory: flags a bill that does not match the slab estimate', () => {
  const rows = [{ id: 1, billing_month: 'Jan 2026', actual_units_kwh: 145, actual_bill_amount: Math.round(expected145 * 1.4) }];
  const h = analyzeHistory(rows, slabs, 2);
  assert.ok(h.points[0].flags.some((f) => f.type === 'bill_mismatch'));
});

test('analyzeHistory: empty history is safe', () => {
  const h = analyzeHistory([], slabs, 2);
  assert.equal(h.count, 0);
  assert.equal(h.highest, null);
});