const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./database/db');
const { calculateApplianceEnergy, calculateTariffCost, calculateRetrofitROI } = require('./services/calculator');
const { generateAuditRecommendations } = require('./services/recommendations');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
async function getActiveTariffSlabs() {
  const [rows] = await db.execute('SELECT * FROM tariff_slabs ORDER BY min_units ASC');
  return rows;
}

/** Returns an error string, or null if the appliance payload is valid. */
function validateAppliance(body) {
  const name = String(body.appliance_name || '').trim();
  if (!name) return 'Appliance name is required';
  if (name.length > 100) return 'Appliance name is too long (max 100 characters)';
  if (!String(body.category || '').trim()) return 'Category is required';

  const quantity = Number(body.quantity);
  const wattage = Number(body.wattage);
  const hours = Number(body.daily_hours);
  const days = body.days_per_month === undefined ? 30 : Number(body.days_per_month);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return 'Quantity must be a whole number between 1 and 1000';
  if (!Number.isFinite(wattage) || wattage <= 0 || wattage > 100000) return 'Wattage must be greater than 0';
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return 'Daily hours must be between 0 and 24';
  if (!Number.isFinite(days) || days < 1 || days > 31) return 'Days per month must be between 1 and 31';
  return null;
}

/**
 * Every page load creates a new anonymous session, so old ones pile up.
 * Delete sessions (and their data) older than 24 hours.
 */
async function cleanupOldSessions() {
  const oldIds = 'SELECT id FROM audit_sessions WHERE created_at < (NOW() - INTERVAL 1 DAY)';
  // Child tables first, in case foreign keys were created without ON DELETE CASCADE
  for (const table of ['retrofit_scenarios', 'bill_records', 'appliances']) {
    try {
      await db.execute(`DELETE FROM ${table} WHERE session_id IN (${oldIds})`);
    } catch (err) {
      // Table may not exist in your database; safe to ignore
    }
  }
  try {
    const [result] = await db.execute('DELETE FROM audit_sessions WHERE created_at < (NOW() - INTERVAL 1 DAY)');
    if (result.affectedRows > 0) console.log(`🧹 Removed ${result.affectedRows} expired session(s)`);
  } catch (err) {
    console.error('Session cleanup failed:', err.message);
  }
}

// -------------------------------------------------------------
// 1. Session & Overview APIs
// -------------------------------------------------------------
app.post('/api/session/init', async (req, res) => {
  try {
    const {
      property_name = 'My Home',
      property_type = 'Household',
      state_region = 'Bihar',
      sanctioned_load_kw = 2.0,
      with_sample = false
    } = req.body;
    const sessionId = crypto.randomUUID();

    await db.execute(`
      INSERT INTO audit_sessions (id, property_name, property_type, state_region, sanctioned_load_kw)
      VALUES (?, ?, ?, ?, ?)
    `, [sessionId, property_name, property_type, state_region, sanctioned_load_kw]);

    // Sample data is only added when explicitly requested; new sessions start empty.
    if (with_sample === true) {
      const defaultAppliances = [
        { name: 'LED Bulbs', category: 'Lighting', qty: 5, wattage: 9, hours: 6 },
        { name: 'Ceiling Fans', category: 'Cooling', qty: 3, wattage: 75, hours: 10 },
        { name: 'Television', category: 'Entertainment', qty: 1, wattage: 100, hours: 4 },
        { name: 'Refrigerator (Frost-Free)', category: 'Refrigeration', qty: 1, wattage: 150, hours: 8 }
      ];

      for (const item of defaultAppliances) {
        await db.execute(`
          INSERT INTO appliances (session_id, appliance_name, category, quantity, wattage, daily_hours, days_per_month)
          VALUES (?, ?, ?, ?, ?, ?, 30)
        `, [sessionId, item.name, item.category, item.qty, item.wattage, item.hours]);
      }

      await db.execute(`
        INSERT INTO bill_records (session_id, billing_month, actual_units_kwh, actual_bill_amount)
        VALUES (?, 'Current Month', 145.0, 1160.0)
      `, [sessionId]);
    }

    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update property name / sanctioned load for a session
app.put('/api/session/:sessionId', async (req, res) => {
  try {
    const { property_name, sanctioned_load_kw } = req.body;
    const name = String(property_name || '').trim();
    const load = Number(sanctioned_load_kw);

    if (!name) return res.status(400).json({ error: 'Property name is required' });
    if (name.length > 100) return res.status(400).json({ error: 'Property name is too long' });
    if (!Number.isFinite(load) || load <= 0 || load > 1000) {
      return res.status(400).json({ error: 'Sanctioned load must be greater than 0' });
    }

    const [result] = await db.execute(
      'UPDATE audit_sessions SET property_name = ?, sanctioned_load_kw = ? WHERE id = ?',
      [name, load, req.params.sessionId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Session not found' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. Bill Management APIs
// -------------------------------------------------------------
app.get('/api/bill/:sessionId', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bill_records WHERE session_id = ? ORDER BY id DESC LIMIT 1', [req.params.sessionId]);
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bill/:sessionId', async (req, res) => {
  try {
    const { billing_month, actual_units_kwh, actual_bill_amount } = req.body;
    const sessionId = req.params.sessionId;

    const units = Number(actual_units_kwh);
    const amount = Number(actual_bill_amount);
    if (!Number.isFinite(units) || units < 0) return res.status(400).json({ error: 'Units billed must be a valid number' });
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Bill amount must be a valid number' });

    const [existing] = await db.execute('SELECT id FROM bill_records WHERE session_id = ?', [sessionId]);

    if (existing.length > 0) {
      await db.execute(`
        UPDATE bill_records 
        SET billing_month = ?, actual_units_kwh = ?, actual_bill_amount = ?
        WHERE session_id = ?
      `, [billing_month || 'Current Month', units, amount, sessionId]);
    } else {
      await db.execute(`
        INSERT INTO bill_records (session_id, billing_month, actual_units_kwh, actual_bill_amount)
        VALUES (?, ?, ?, ?)
      `, [sessionId, billing_month || 'Current Month', units, amount]);
    }

    res.json({ success: true, message: 'Bill record updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. Appliance Inventory APIs
// -------------------------------------------------------------
app.get('/api/appliances/:sessionId', async (req, res) => {
  try {
    const [appliances] = await db.execute('SELECT * FROM appliances WHERE session_id = ? ORDER BY id ASC', [req.params.sessionId]);
    const enriched = appliances.map(item => ({ ...item, ...calculateApplianceEnergy(item) }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/appliances/:sessionId', async (req, res) => {
  try {
    const problem = validateAppliance(req.body);
    if (problem) return res.status(400).json({ error: problem });

    const { appliance_name, category, quantity, wattage, daily_hours, days_per_month = 30 } = req.body;
    const [result] = await db.execute(`
      INSERT INTO appliances (session_id, appliance_name, category, quantity, wattage, daily_hours, days_per_month)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [req.params.sessionId, String(appliance_name).trim(), category, Number(quantity), Number(wattage), Number(daily_hours), Number(days_per_month)]);

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/appliances/:id', async (req, res) => {
  try {
    const problem = validateAppliance(req.body);
    if (problem) return res.status(400).json({ error: problem });

    const { appliance_name, category, quantity, wattage, daily_hours, days_per_month = 30 } = req.body;
    const [result] = await db.execute(`
      UPDATE appliances 
      SET appliance_name = ?, category = ?, quantity = ?, wattage = ?, daily_hours = ?, days_per_month = ?
      WHERE id = ?
    `, [String(appliance_name).trim(), category, Number(quantity), Number(wattage), Number(daily_hours), Number(days_per_month), req.params.id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Appliance not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/appliances/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM appliances WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. Audit Engine & Dashboard Summary API
// -------------------------------------------------------------
app.get('/api/audit-summary/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const [sessionRows] = await db.execute('SELECT * FROM audit_sessions WHERE id = ?', [sessionId]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const [appliances] = await db.execute('SELECT * FROM appliances WHERE session_id = ?', [sessionId]);
    const [billRows] = await db.execute('SELECT * FROM bill_records WHERE session_id = ? ORDER BY id DESC LIMIT 1', [sessionId]);
    const billRecord = billRows[0];

    const slabs = await getActiveTariffSlabs();

    let totalCalculatedDailyKwh = 0;
    let totalCalculatedMonthlyKwh = 0;

    const enrichedAppliances = appliances.map(item => {
      const calc = calculateApplianceEnergy(item);
      totalCalculatedDailyKwh += (calc.totalDailyKwh || 0);
      totalCalculatedMonthlyKwh += (calc.monthlyKwh || 0);
      return { ...item, ...calc };
    });

    const applianceBreakdown = enrichedAppliances.map(item => ({
      ...item,
      percentageShare: totalCalculatedMonthlyKwh > 0
        ? Number(((item.monthlyKwh / totalCalculatedMonthlyKwh) * 100).toFixed(1))
        : 0
    })).sort((a, b) => (b.monthlyKwh || 0) - (a.monthlyKwh || 0));

    const categoryBreakdown = {};
    applianceBreakdown.forEach(item => {
      if (!categoryBreakdown[item.category]) {
        categoryBreakdown[item.category] = { category: item.category, monthlyKwh: 0, percentage: 0 };
      }
      categoryBreakdown[item.category].monthlyKwh += (item.monthlyKwh || 0);
    });

    Object.keys(categoryBreakdown).forEach(cat => {
      categoryBreakdown[cat].monthlyKwh = Number(categoryBreakdown[cat].monthlyKwh.toFixed(2));
      categoryBreakdown[cat].percentage = totalCalculatedMonthlyKwh > 0
        ? Number(((categoryBreakdown[cat].monthlyKwh / totalCalculatedMonthlyKwh) * 100).toFixed(1))
        : 0;
    });

    const calculatedBillTariff = calculateTariffCost(totalCalculatedMonthlyKwh, slabs, session.sanctioned_load_kw) || {};

    const actualUnits = (billRecord && billRecord.actual_units_kwh != null)
      ? Number(billRecord.actual_units_kwh)
      : totalCalculatedMonthlyKwh;

    const actualBillTariff = calculateTariffCost(actualUnits, slabs, session.sanctioned_load_kw) || {};

    const unaccountedUnits = Number(Math.max(0, actualUnits - totalCalculatedMonthlyKwh).toFixed(2));
    const unaccountedCost = Number((unaccountedUnits * (calculatedBillTariff.marginalRatePerUnit || 0)).toFixed(2));

    const rawRecommendations = generateAuditRecommendations({
      appliances: enrichedAppliances,
      billRecord,
      tariffBreakdown: calculatedBillTariff,
      calculatedTotalUnits: totalCalculatedMonthlyKwh
    }) || [];

    const recommendations = rawRecommendations.map(rec => ({
      ...rec,
      estimatedMonthlySavings: Number(rec.estimatedMonthlySavings || 0)
    }));

    const totalPotentialSavingsMonthly = recommendations.reduce((sum, r) => sum + r.estimatedMonthlySavings, 0);

    const finalActualBillAmount = (billRecord && billRecord.actual_bill_amount != null)
      ? Number(billRecord.actual_bill_amount)
      : (actualBillTariff.totalEstimatedBill || 0);

    res.json({
      session,
      metrics: {
        totalCalculatedDailyKwh: Number(totalCalculatedDailyKwh || 0),
        totalCalculatedMonthlyKwh: Number(totalCalculatedMonthlyKwh || 0),
        actualUnitsKwh: Number(actualUnits || 0),
        actualBillAmount: Number(finalActualBillAmount || 0),
        estimatedCalculatedBill: Number(calculatedBillTariff.totalEstimatedBill || 0),
        unaccountedUnits: Number(unaccountedUnits || 0),
        unaccountedCost: Number(unaccountedCost || 0),
        totalPotentialSavingsMonthly: Number(totalPotentialSavingsMonthly || 0),
        marginalRate: Number(calculatedBillTariff.marginalRatePerUnit || 0),
        averageRate: Number(calculatedBillTariff.averageRatePerUnit || 0)
      },
      tariffDetails: {
        ...calculatedBillTariff,
        energyCharges: Number(calculatedBillTariff.energyCharges || 0),
        fixedCharges: Number(calculatedBillTariff.fixedCharges || 0),
        electricityDuty: Number(calculatedBillTariff.electricityDuty || 0),
        totalEstimatedBill: Number(calculatedBillTariff.totalEstimatedBill || 0),
        slabBreakdown: (calculatedBillTariff.slabBreakdown || []).map(slab => ({
          ...slab,
          rate: Number(slab.rate || 0),
          units: Number(slab.units || 0),
          cost: Number(slab.cost || 0)
        }))
      },
      applianceBreakdown,
      categoryBreakdown: Object.values(categoryBreakdown),
      recommendations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 5. Savings Simulator & Retrofit Calculator APIs
// -------------------------------------------------------------
app.post('/api/simulator/calculate', (req, res) => {
  try {
    const { existingWattage, newWattage, quantity, dailyHours, capitalCost, tariffRate = 8.0 } = req.body;
    const values = [existingWattage, newWattage, quantity, dailyHours, capitalCost, tariffRate].map(Number);
    if (values.some(v => !Number.isFinite(v) || v < 0)) {
      return res.status(400).json({ error: 'All simulator inputs must be non-negative numbers' });
    }
    res.json(calculateRetrofitROI(...values));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 6. Tariffs Metadata API
// -------------------------------------------------------------
app.get('/api/tariffs', async (req, res) => {
  try {
    const slabs = await getActiveTariffSlabs();
    res.json(slabs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Fallbacks
// -------------------------------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' });
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`⚡ UrjaAudit Energy Assistant Server Running`);
  console.log(`🌐 Local Web Portal: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  // Clear out expired anonymous sessions now, then once an hour
  cleanupOldSessions();
  setInterval(cleanupOldSessions, 60 * 60 * 1000);
});