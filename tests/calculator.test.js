const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateApplianceEnergy, calculateTariffCost, calculateRetrofitROI } = require('../services/calculator');

const slabs = [
  { min_units: 0, max_units: 50, rate_per_kwh: 6.10, fixed_charge_monthly: 40, duty_tax_percentage: 6 },
  { min_units: 51, max_units: 100, rate_per_kwh: 6.95, fixed_charge_monthly: 40, duty_tax_percentage: 6 },
  { min_units: 101, max_units: 200, rate_per_kwh: 8.05, fixed_charge_monthly: 60, duty_tax_percentage: 6 },
  { min_units: 201, max_units: 300, rate_per_kwh: 9.15, fixed_charge_monthly: 80, duty_tax_percentage: 6 },
  { min_units: 301, max_units: null, rate_per_kwh: 10.0, fixed_charge_monthly: 100, duty_tax_percentage: 6 }
];

const near = (actual, expected, eps = 0.02) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} to be within ${eps} of ${expected}`);

test('appliance energy: 3 fans of 75 W for 10 h over 30 days = 67.5 kWh', () => {
  const r = calculateApplianceEnergy({ wattage: 75, quantity: 3, daily_hours: 10, days_per_month: 30 });
  near(r.totalDailyKwh, 2.25);
  near(r.monthlyKwh, 67.5);
});

test('appliance energy: bad input does not produce NaN', () => {
  const r = calculateApplianceEnergy({ wattage: 'abc', quantity: 2, daily_hours: 5 });
  assert.equal(r.monthlyKwh, 0);
});

test('tariff: 145 units spreads across three slabs', () => {
  const r = calculateTariffCost(145, slabs, 2);
  assert.equal(r.slabBreakdown.length, 3);
  near(r.slabBreakdown[0].units, 50);
  near(r.slabBreakdown[1].units, 50);
  near(r.slabBreakdown[2].units, 45);
  near(r.energyCharges, 1014.75);
  near(r.fixedCharges, 80);
  near(r.totalEstimatedBill, 1155.635, 0.02);
  assert.equal(r.marginalRatePerUnit, 8.05);
});

test('tariff: 30 units stays in the first slab', () => {
  const r = calculateTariffCost(30, slabs, 2);
  assert.equal(r.slabBreakdown.length, 1);
  near(r.energyCharges, 183);
});

test('tariff: units above 300 reach the open-ended slab', () => {
  const r = calculateTariffCost(350, slabs, 2);
  assert.equal(r.slabBreakdown.length, 5);
  near(r.slabBreakdown[4].units, 50);
  assert.equal(r.marginalRatePerUnit, 10);
});

test('tariff: zero units only charges fixed charges', () => {
  const r = calculateTariffCost(0, slabs, 2);
  assert.equal(r.energyCharges, 0);
  near(r.totalEstimatedBill, 80);
});

test('retrofit ROI matches the default UI example (3 fans, 75 W to 28 W)', () => {
  const r = calculateRetrofitROI(75, 28, 3, 10, 7200, 8);
  near(r.unitsSavedMonthly, 42.3);
  near(r.monthlySavingsInr, 338.4);
  near(r.paybackMonths, 21.3, 0.05);
});