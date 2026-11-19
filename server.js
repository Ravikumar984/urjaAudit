require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const db = require('./database/db');
const { calculateApplianceEnergy, calculateTariffCost, calculateRetrofitROI } = require('./services/calculator');
const { generateAuditRecommendations } = require('./services/recommendations');
const { checkBill, analyzeHistory } = require('./services/billAnalysis');
const { calculateSolar } = require('./services/solar');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_BILLS_PER_SESSION = 36;

// Behind a proxy (Render, Railway...) set TRUST_PROXY=1 so rate limiting sees real client IPs
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// -------------------------------------------------------------
// Security middleware
// -------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'upgrade-insecure-requests': null // would break plain http://localhost in some browsers
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});
// Every page load creates a session, so cap it per IP (raise this if a whole class shares one network)
const sessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many new audits from this network. Please try again later.' }
});
app.use('/api', apiLimiter);
app.use('/api/session/init', sessionLimiter);

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function handleError(res, err) {
  console.error(err);
  res.status(500).json({ error: IS_PROD ? 'Something went wrong on the server' : err.message });
}

async function getActiveTariffSlabs() {
  const [rows] = await db.execute('SELECT * FROM tariff_slabs ORDER BY min_units ASC');
  return rows;
}

/** Makes sure the session in the URL exists (also gives a clean 404 instead of a DB error). */
async function requireSession(req, res, next) {
  try {
    const [rows] = await db.execute('SELECT id FROM audit_sessions WHERE id = ?', [req.params.sessionId]);
    if (!rows.length) return res.status(404).json({ error: 'Session not found. Refresh the page to start a new audit.' });
    next();
  } catch (err) {
    handleError(res, err);
  }
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

/** Returns { error } or { label, units, amount }. */
function validateBill(body) {
  const label = String(body.billing_month || '').trim();
  const units = Number(body.actual_units_kwh);
  const amount = Number(body.actual_bill_amount);
  if (!label) return { error: 'Enter a billing month, for example "Dec 2026"' };
  if (label.length > 20) return { error: 'Billing month is too long (max 20 characters)' };
  if (!Number.isFinite(units) || units < 0 || units > 100000) return { error: 'Units billed must be a valid number' };
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) return { error: 'Bill amount must be a valid number' };
  return { label, units, amount };
}

/** Delete anonymous sessions (and their data) older than 24 hours. */
async function cleanupOldSessions() {
  const oldIds = 'SELECT id FROM audit_sessions WHERE created_at < (NOW() - INTERVAL 1 DAY)';
  for (const table of ['retrofit_scenarios', 'bill_records', 'appliances']) {
    try {
      await db.execute(`DELETE FROM ${table} WHERE session_id IN (${oldIds})`);
    } catch (err) {
      // table may not exist in your database; safe to ignore
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
// Health check
// -------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unreachable' });
  }
});

// -------------------------------------------------------------
// 1. Session APIs
// -------------------------------------------------------------
app.post('/api/session/init', async (req, res) => {
  try {
    const body = req.body || {};
    const property_name = String(body.property_name || 'My Home').trim().slice(0, 100) || 'My Home';
    const property_type = String(body.property_type || 'Household').trim().slice(0, 50);
    const state_region = String(body.state_region || 'Bihar').trim().slice(0, 50);
    const load = Number(body.sanctioned_load_kw);
    const sanctioned_load_kw = Number.isFinite(load) && load > 0 && load <= 1000 ? load : 2.0;
    const sessionId = crypto.randomUUID();

    await db.execute(`
      INSERT INTO audit_sessions (id, property_name, property_type, state_region, sanctioned_load_kw)
      VALUES (?, ?, ?, ?, ?)
    `, [sessionId, property_name, property_type, state_region, sanctioned_load_kw]);

    // Sample data only when explicitly requested; normal sessions start empty.
    if (body.with_sample === true) {
      const sampleAppliances = [
        { name: 'LED Bulbs', category: 'Lighting', qty: 5, wattage: 9, hours: 6 },
        { name: 'Ceiling Fans', category: 'Cooling', qty: 3, wattage: 75, hours: 10 },
        { name: 'Television', category: 'Entertainment', qty: 1, wattage: 100, hours: 4 },
        { name: 'Refrigerator (Frost-Free)', category: 'Refrigeration', qty: 1, wattage: 150, hours: 8 }
      ];
      for (const item of sampleAppliances) {
        await db.execute(`
          INSERT INTO appliances (session_id, appliance_name, category, quantity, wattage, daily_hours, days_per_month)
          VALUES (?, ?, ?, ?, ?, ?, 30)
        `, [sessionId, item.name, item.category, item.qty, item.wattage, item.hours]);
      }

      // Six months of sample bills (August is deliberately high so the spike detector has something to show)
      const slabs = await getActiveTariffSlabs();
      const sampleBills = [
        ['Jun 2026', 172], ['Jul 2026', 186], ['Aug 2026', 231],
        ['Sep 2026', 178], ['Oct 2026', 158], ['Nov 2026', 145]
      ];
      for (const [label, units] of sampleBills) {
        const amount = Math.round(calculateTariffCost(units, slabs, sanctioned_load_kw).totalEstimatedBill);
        await db.execute(`
          INSERT INTO bill_records (session_id, billing_month, actual_units_kwh, actual_bill_amount)
          VALUES (?, ?, ?, ?)
        `, [sessionId, label, units, amount]);
      }
    }

    res.json({ success: true, sessionId });
  } catch (err) {
    handleError(res, err);
  }
});

app.put('/api/session/:sessionId', async (req, res) => {
  try {
    const { property_name, sanctioned_load_kw } = req.body || {};
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
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// 2. Bill APIs (each billing_month label is one record = bill history)
// -------------------------------------------------------------
app.get('/api/bill/:sessionId', requireSession, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bill_records WHERE session_id = ? ORDER BY id DESC LIMIT 1', [req.params.sessionId]);
    res.json(rows[0] || null);
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/bill/:sessionId', requireSession, async (req, res) => {
  try {
    const v = validateBill(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const sessionId = req.params.sessionId;

    const [existing] = await db.execute(
      'SELECT id FROM bill_records WHERE session_id = ? AND billing_month = ?',
      [sessionId, v.label]
    );

    if (existing.length > 0) {
      await db.execute(
        'UPDATE bill_records SET actual_units_kwh = ?, actual_bill_amount = ? WHERE id = ?',
        [v.units, v.amount, existing[0].id]
      );
      return res.json({ success: true, updated: true });
    }

    const [[{ total }]] = await db.execute('SELECT COUNT(*) AS total FROM bill_records WHERE session_id = ?', [sessionId]);
    if (total >= MAX_BILLS_PER_SESSION) {
      return res.status(400).json({ error: `You can keep up to ${MAX_BILLS_PER_SESSION} months of bills. Delete one first.` });
    }

    await db.execute(`
      INSERT INTO bill_records (session_id, billing_month, actual_units_kwh, actual_bill_amount)
      VALUES (?, ?, ?, ?)
    `, [sessionId, v.label, v.units, v.amount]);
    res.json({ success: true, updated: false });
  } catch (err) {
    handleError(res, err);
  }
});

app.delete('/api/bill/:sessionId/:billId', requireSession, async (req, res) => {
  try {
    const billId = parseId(req.params.billId);
    if (!billId) return res.status(400).json({ error: 'Invalid bill id' });
    const [result] = await db.execute(
      'DELETE FROM bill_records WHERE id = ? AND session_id = ?',
      [billId, req.params.sessionId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Bill not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// 3. Appliance APIs (edits are tied to the session that owns them)
// -------------------------------------------------------------
app.get('/api/appliances/:sessionId', requireSession, async (req, res) => {
  try {
    const [appliances] = await db.execute('SELECT * FROM appliances WHERE session_id = ? ORDER BY id ASC', [req.params.sessionId]);
    res.json(appliances.map((item) => ({ ...item, ...calculateApplianceEnergy(item) })));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/appliances/:sessionId', requireSession, async (req, res) => {
  try {
    const body = req.body || {};
    const problem = validateAppliance(body);
    if (problem) return res.status(400).json({ error: problem });

    const { appliance_name, category, quantity, wattage, daily_hours, days_per_month = 30 } = body;
    const [result] = await db.execute(`
      INSERT INTO appliances (session_id, appliance_name, category, quantity, wattage, daily_hours, days_per_month)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [req.params.sessionId, String(appliance_name).trim(), category, Number(quantity), Number(wattage), Number(daily_hours), Number(days_per_month)]);

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    handleError(res, err);
  }
});

app.put('/api/appliances/:sessionId/:id', requireSession, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid appliance id' });
    const body = req.body || {};
    const problem = validateAppliance(body);
    if (problem) return res.status(400).json({ error: problem });

    const { appliance_name, category, quantity, wattage, daily_hours, days_per_month = 30 } = body;
    const [result] = await db.execute(`
      UPDATE appliances
      SET appliance_name = ?, category = ?, quantity = ?, wattage = ?, daily_hours = ?, days_per_month = ?
      WHERE id = ? AND session_id = ?
    `, [String(appliance_name).trim(), category, Number(quantity), Number(wattage), Number(daily_hours), Number(days_per_month), id, req.params.sessionId]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Appliance not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.delete('/api/appliances/:sessionId/:id', requireSession, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid appliance id' });
    const [result] = await db.execute('DELETE FROM appliances WHERE id = ? AND session_id = ?', [id, req.params.sessionId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Appliance not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// 4. Audit summary (dashboard, bill check, bill history)
// -------------------------------------------------------------
app.get('/api/audit-summary/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const [sessionRows] = await db.execute('SELECT * FROM audit_sessions WHERE id = ?', [sessionId]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const sanctionedLoad = Number(session.sanctioned_load_kw) || 2;

    const [appliances] = await db.execute('SELECT * FROM appliances WHERE session_id = ?', [sessionId]);
    const [billRows] = await db.execute('SELECT * FROM bill_records WHERE session_id = ? ORDER BY id ASC', [sessionId]);
    const billRecord = billRows[billRows.length - 1]; // latest bill

    const slabs = await getActiveTariffSlabs();

    let totalCalculatedDailyKwh = 0;
    let totalCalculatedMonthlyKwh = 0;

    const enrichedAppliances = appliances.map((item) => {
      const calc = calculateApplianceEnergy(item);
      totalCalculatedDailyKwh += (calc.totalDailyKwh || 0);
      totalCalculatedMonthlyKwh += (calc.monthlyKwh || 0);
      return { ...item, ...calc };
    });

    const applianceBreakdown = enrichedAppliances.map((item) => ({
      ...item,
      percentageShare: totalCalculatedMonthlyKwh > 0
        ? Number(((item.monthlyKwh / totalCalculatedMonthlyKwh) * 100).toFixed(1))
        : 0
    })).sort((a, b) => (b.monthlyKwh || 0) - (a.monthlyKwh || 0));

    const categoryBreakdown = {};
    applianceBreakdown.forEach((item) => {
      if (!categoryBreakdown[item.category]) {
        categoryBreakdown[item.category] = { category: item.category, monthlyKwh: 0, percentage: 0 };
      }
      categoryBreakdown[item.category].monthlyKwh += (item.monthlyKwh || 0);
    });
    Object.keys(categoryBreakdown).forEach((cat) => {
      categoryBreakdown[cat].monthlyKwh = Number(categoryBreakdown[cat].monthlyKwh.toFixed(2));
      categoryBreakdown[cat].percentage = totalCalculatedMonthlyKwh > 0
        ? Number(((categoryBreakdown[cat].monthlyKwh / totalCalculatedMonthlyKwh) * 100).toFixed(1))
        : 0;
    });

    const calculatedBillTariff = calculateTariffCost(totalCalculatedMonthlyKwh, slabs, sanctionedLoad) || {};

    const actualUnits = (billRecord && billRecord.actual_units_kwh != null)
      ? Number(billRecord.actual_units_kwh)
      : totalCalculatedMonthlyKwh;
    const actualBillTariff = calculateTariffCost(actualUnits, slabs, sanctionedLoad) || {};

    const unaccountedUnits = Number(Math.max(0, actualUnits - totalCalculatedMonthlyKwh).toFixed(2));
    const unaccountedCost = Number((unaccountedUnits * (calculatedBillTariff.marginalRatePerUnit || 0)).toFixed(2));

    const rawRecommendations = generateAuditRecommendations({
      appliances: enrichedAppliances,
      billRecord,
      tariffBreakdown: calculatedBillTariff,
      calculatedTotalUnits: totalCalculatedMonthlyKwh
    }) || [];

    const recommendations = rawRecommendations.map((rec) => ({
      ...rec,
      estimatedMonthlySavings: Number(rec.estimatedMonthlySavings || 0)
    }));
    const totalPotentialSavingsMonthly = recommendations.reduce((sum, r) => sum + r.estimatedMonthlySavings, 0);

    const finalActualBillAmount = (billRecord && billRecord.actual_bill_amount != null)
      ? Number(billRecord.actual_bill_amount)
      : (actualBillTariff.totalEstimatedBill || 0);

    const billCheck = billRecord
      ? checkBill({
          units: Number(billRecord.actual_units_kwh),
          amount: Number(billRecord.actual_bill_amount),
          slabs,
          sanctionedLoad,
          calculatedUnits: totalCalculatedMonthlyKwh
        })
      : null;
    const billHistory = analyzeHistory(billRows, slabs, sanctionedLoad);

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
        slabBreakdown: (calculatedBillTariff.slabBreakdown || []).map((slab) => ({
          ...slab,
          rate: Number(slab.rate || 0),
          units: Number(slab.units || 0),
          cost: Number(slab.cost || 0)
        }))
      },
      applianceBreakdown,
      categoryBreakdown: Object.values(categoryBreakdown),
      recommendations,
      billCheck,
      billHistory
    });
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// 5. Simulator, solar planner
// -------------------------------------------------------------
app.post('/api/simulator/calculate', (req, res) => {
  try {
    const { existingWattage, newWattage, quantity, dailyHours, capitalCost, tariffRate = 8.0 } = req.body || {};
    const values = [existingWattage, newWattage, quantity, dailyHours, capitalCost, tariffRate].map(Number);
    if (values.some((v) => !Number.isFinite(v) || v < 0)) {
      return res.status(400).json({ error: 'All simulator inputs must be non-negative numbers' });
    }
    res.json(calculateRetrofitROI(...values));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/solar/calculate', async (req, res) => {
  try {
    const b = req.body || {};
    const monthlyUnits = Number(b.monthlyUnits);
    const sunHours = b.sunHours === undefined ? 4.5 : Number(b.sunHours);
    const costPerKw = b.costPerKw === undefined ? 60000 : Number(b.costPerKw);
    const offsetPercent = b.offsetPercent === undefined ? 100 : Number(b.offsetPercent);
    const sanctionedLoadKw = b.sanctionedLoad === undefined ? 2 : Number(b.sanctionedLoad);
    const applySubsidy = b.applySubsidy !== false;

    if (!Number.isFinite(monthlyUnits) || monthlyUnits <= 0 || monthlyUnits > 5000) {
      return res.status(400).json({ error: 'Monthly units must be between 1 and 5000' });
    }
    if (!Number.isFinite(sunHours) || sunHours < 2 || sunHours > 7) {
      return res.status(400).json({ error: 'Peak sun hours must be between 2 and 7' });
    }
    if (!Number.isFinite(costPerKw) || costPerKw < 20000 || costPerKw > 150000) {
      return res.status(400).json({ error: 'Cost per kW must be between ₹20,000 and ₹1,50,000' });
    }
    if (!Number.isFinite(offsetPercent) || offsetPercent < 10 || offsetPercent > 100) {
      return res.status(400).json({ error: 'Usage to cover must be between 10% and 100%' });
    }
    if (!Number.isFinite(sanctionedLoadKw) || sanctionedLoadKw <= 0 || sanctionedLoadKw > 1000) {
      return res.status(400).json({ error: 'Sanctioned load must be greater than 0' });
    }

    const slabs = await getActiveTariffSlabs();
    res.json(calculateSolar({ monthlyUnits, sunHours, costPerKw, offsetPercent, applySubsidy, sanctionedLoadKw, slabs }));
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// 6. Tariffs metadata
// -------------------------------------------------------------
app.get('/api/tariffs', async (req, res) => {
  try {
    res.json(await getActiveTariffSlabs());
  } catch (err) {
    handleError(res, err);
  }
});

// -------------------------------------------------------------
// Fallbacks
// -------------------------------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = status < 500 ? err.message : (IS_PROD ? 'Something went wrong on the server' : err.message);
  res.status(status).json({ error: message });
});

app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`⚡ UrjaAudit Energy Assistant Server Running`);
  console.log(`🌐 Local Web Portal: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  try {
    await db.query('SELECT 1');
    console.log('✅ Database connected');
    cleanupOldSessions();
    setInterval(cleanupOldSessions, 60 * 60 * 1000);
  } catch (err) {
    console.error(`❌ Cannot reach the database: ${err.message}`);
    console.error('   If you use Aiven, check the service is powered on, then restart this server.');
  }
});