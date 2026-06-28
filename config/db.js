/**
 * ============================================================
 * config/db.js - Database Configuration Pool
 * ============================================================
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

// Use SSL if deploying to non-localhost environments (Render/Neon etc.)
const sslConfig = connectionString && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1')
  ? { rejectUnauthorized: false }
  : false;

const pool = connectionString
  ? new Pool({ connectionString, ssl: sslConfig })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'webtest',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    });

module.exports = { pool };
