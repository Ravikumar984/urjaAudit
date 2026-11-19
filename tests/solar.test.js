const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSolar, pmSuryaGharSubsidy } = require('../services/solar');

const slabs = [
  { min_units: 0, max_units: 50, rate_per_kwh: 6.10, fixed_charge_monthly: 40, duty_tax_percentage: 6 },
  { min_units: 51, max_units: 100, rate_per_kwh: 6.95, fixed_charge_monthly: 40, duty_tax_percentage: 6 },
  { min_units: 101, max_units: 200, rate_per_kwh: 8.05, fixed_charge_monthly: 60, duty_tax_percentage: 6 },
  { min_units: 201, max_units: 300, rate_per_kwh: 9.15, fixed_charge_monthly: 80, duty_tax_percentage: 6 },
  { min_units: 301, max_units: null, rate_per_kwh: 10.0, fixed_charge_monthly: 100, duty_tax_percentage: 6 }
];

test('subsidy follows the per-kW rule and the cap', () => {
  assert.equal(pmSuryaGharSubsidy(1), 30000);
  assert.equal(pmSuryaGharSubsidy(1.5), 45000);
  assert.equal(pmSuryaGharSubsidy(2), 60000);
  assert.equal(pmSuryaGharSubsidy(3), 78000);
  assert.equal(pmSuryaGharSubsidy(5), 78000);
});

test('150 units a month sizes to 1.5 kW and covers all usage', () => {
  const r = calculateSolar({ monthlyUnits: 150, slabs });
  assert.equal(r.sizeKw, 1.5);
  assert.equal(r.grossCost, 90000);
  assert.equal(r.subsidy, 45000);
  assert.equal(r.netCost, 45000);
  assert.equal(r.coveragePercent, 100);
  assert.ok(r.monthlySavings > 0);
  assert.ok(r.paybackYears > 0 && r.paybackYears < 25);
  assert.equal(r.cashflow.length, 26);
  assert.equal(r.cashflow[0].value, -45000);
});

test('without subsidy the payback is longer', () => {
  const withSub = calculateSolar({ monthlyUnits: 150, slabs, applySubsidy: true });
  const without = calculateSolar({ monthlyUnits: 150, slabs, applySubsidy: false });
  assert.equal(without.subsidy, 0);
  assert.ok(without.paybackYears > withSub.paybackYears);
});

test('covering only half the usage gives a smaller system', () => {
  const full = calculateSolar({ monthlyUnits: 300, slabs, offsetPercent: 100 });
  const half = calculateSolar({ monthlyUnits: 300, slabs, offsetPercent: 50 });
  assert.ok(half.sizeKw < full.sizeKw);
});

test('system size is capped for residential use', () => {
  const r = calculateSolar({ monthlyUnits: 5000, slabs });
  assert.equal(r.sizeKw, 10);
});