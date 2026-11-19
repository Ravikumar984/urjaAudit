# UrjaAudit: Understand, verify and reduce your electricity bill

## The problem
Household electricity bills in India use slab-based tariffs that most people cannot verify or break down.
Families cannot tell whether a bill is correct, where their units go, or which changes would save the most money.

## The solution
UrjaAudit is a web app with three parts:

| Pillar | What it does |
|---|---|
| **Understand** | Appliance inventory, load breakdown, slab ladder showing which tariff slab you sit in |
| **Verify** | Bill checker compares your bill with the slab estimate and explains differences; bill history flags unusual months |
| **Reduce** | Savings plan with payback, usage simulator, retrofit ROI calculator, rooftop solar planner |

Every visit starts with an empty audit, so no login is needed and no personal data is kept (sessions are deleted after 24 hours).

## Features
- Efficiency score, bill reconciliation (appliance list vs meter), carbon estimate
- Bill check with a verdict (OK / a little off / far off), possible reasons and next steps
- Bill history with trend and spike/drop detection
- Rooftop solar planner: system size, subsidy estimate, payback, 25-year cash flow
- Printable report and CSV export, dark mode, responsive layout

## Tech stack
Node.js, Express, MySQL (mysql2), vanilla JavaScript, native SVG charts. Security: helmet (CSP), rate limiting, input validation, session-scoped data access.

## Architecture
```
Browser (HTML/CSS/JS)  --->  Express API  --->  MySQL
                              |-- services/calculator.js     slab maths
                              |-- services/billAnalysis.js   bill check, history trends
                              |-- services/solar.js          solar sizing and payback
                              |-- services/recommendations.js rule engine
```

## Setup
1. Install Node.js 18 or newer and MySQL.
2. Create the database and tables: run `database/schema.mysql.sql`.
3. Copy `.env.example` to `.env` and fill in your database details.
4. Install and start:
   ```bash
   npm install
   npm start
   ```
5. Open http://localhost:3000

Run the tests with `npm test`.

## API summary
| Method | Route | Purpose |
|---|---|---|
| POST | `/api/session/init` | Start a new (empty or sample) audit |
| PUT | `/api/session/:sessionId` | Update property name and sanctioned load |
| GET/POST | `/api/bill/:sessionId` | Latest bill / add or update a month |
| DELETE | `/api/bill/:sessionId/:billId` | Remove a month from history |
| GET/POST | `/api/appliances/:sessionId` | List / add appliances |
| PUT/DELETE | `/api/appliances/:sessionId/:id` | Edit / delete an appliance |
| GET | `/api/audit-summary/:sessionId` | Dashboard data, bill check, bill history |
| POST | `/api/simulator/calculate` | Retrofit ROI |
| POST | `/api/solar/calculate` | Solar estimate |
| GET | `/api/tariffs`, `/api/health` | Tariff slabs, health check |

## Data sources and accuracy (fill this in before presenting)
- Tariff slabs: **[name the tariff order, year and link here]**. Rates are stored in the `tariff_slabs` table so they can be updated when the regulator revises them.
- Accuracy test: compare the app's estimate with real bills.

| Household | Units | Actual bill | App estimate | Difference |
|---|---|---|---|---|
| (anonymised) | | | | |

## Assumptions and limitations
- Estimates use only slab rates, fixed charges and duty. Real bills can include other charges.
- Solar figures are planning estimates. Costs, sunlight and subsidy rules vary, so confirm with installers and the official PM Surya Ghar portal.
- CO2 figures use rough constants (0.8 kg CO2 per kWh, 21 kg per tree per year).
- There are no user accounts, so an audit cannot be saved across visits.

## Future scope
User accounts, Hindi language support, bill photo scanning (OCR), WhatsApp or SMS reports, smart-meter data.