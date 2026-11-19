const fs = require('fs');
const mysql = require('mysql2');
require('dotenv').config();

/**
 * SSL rules:
 *  - DB_SSL_CA=<path to ca.pem>  -> verified SSL (best, use the CA file from Aiven)
 *  - DB_SSL=true                 -> SSL without certificate verification
 *  - DB_SSL=false                -> no SSL
 *  - not set                     -> SSL for remote hosts, no SSL for localhost
 */
function sslConfig() {
  if (process.env.DB_SSL_CA) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA), rejectUnauthorized: true };
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST);
  const wantSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : !isLocal;
  return wantSsl ? { rejectUnauthorized: false } : undefined;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: sslConfig(),
  decimalNumbers: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool.promise();