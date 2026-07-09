/**
 * ============================================================
 * db/migrate.js - Schema Migrations & Auto Database Creator
 * ============================================================
 */

const { Client } = require('pg');
const { pool } = require('../config/db');

async function ensureDatabaseExists() {
  const connectionString = process.env.DATABASE_URL;
  let targetDb = 'webtest';
  let adminDbUrl = 'postgresql://postgres:123456@localhost:5432/postgres'; // Default fallback

  if (connectionString) {
    try {
      // Parse database URL to find target DB name and construct admin connection URL
      const url = new URL(connectionString);
      targetDb = url.pathname.substring(1) || 'webtest';
      
      // Point admin connection to the default 'postgres' database
      url.pathname = '/postgres';
      adminDbUrl = url.toString();
    } catch (e) {
      console.warn('⚠️ Could not parse DATABASE_URL to create database automatically:', e.message);
    }
  } else {
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || '';
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || 5432;
    targetDb = process.env.DB_NAME || 'webtest';
    
    adminDbUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/postgres`;
  }

  // Connect to default 'postgres' database to check/create the target DB
  const client = new Client({
    connectionString: adminDbUrl,
    ssl: adminDbUrl.includes('localhost') || adminDbUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    
    // Check if target database exists
    const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    
    if (res.rows.length === 0) {
      console.log(`🔨 Database "${targetDb}" not found. Creating it...`);
      await client.query(`CREATE DATABASE "${targetDb}"`);
      console.log(`✅ Database "${targetDb}" created successfully.`);
    }
  } catch (err) {
    console.error(`⚠️ Failed to verify/create database "${targetDb}" automatically:`, err);
  } finally {
    try {
      await client.end();
    } catch (e) {}
  }
}

async function runMigrations() {
  // Step 1: Ensure target database exists
  await ensureDatabaseExists();

  // Step 2: Connect to target database and run schema table creations
  try {
    const client = await pool.connect();
    console.log('🔌 DB Migration: Connected successfully.');

    // 1. Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        picture TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Reports Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        test_id VARCHAR(50) PRIMARY KEY,
        user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
        frontend_url TEXT NOT NULL,
        backend_url TEXT,
        test_date TIMESTAMP WITH TIME ZONE,
        overall_score INTEGER DEFAULT 0,
        total_pages INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'unknown',
        report_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Link Status Cache Table — persistent URL status across test runs
    await client.query(`
      CREATE TABLE IF NOT EXISTS link_status_cache (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(500) NOT NULL,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        status INTEGER DEFAULT 0,
        reason TEXT,
        last_checked TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, normalized_url)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_cache_domain ON link_status_cache(domain);
    `);

    // 4. AI Issues Table — stores AI audit issues per scan report
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_issues (
        id SERIAL PRIMARY KEY,
        test_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        page_url TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        recommended_fix TEXT,
        priority VARCHAR(20) DEFAULT 'Medium',
        status VARCHAR(30) DEFAULT 'open',
        category VARCHAR(50),
        ai_raw_response JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_issues_test ON ai_issues(test_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_issues_user ON ai_issues(user_id);
    `);

    // Ensure columns for new requirements exist
    await client.query(`
      ALTER TABLE ai_issues ADD COLUMN IF NOT EXISTS affected_element TEXT;
    `);
    await client.query(`
      ALTER TABLE ai_issues ADD COLUMN IF NOT EXISTS confidence_score VARCHAR(50);
    `);
    // Structured test-case fields (issue / expected / actual / reproduction)
    await client.query(`
      ALTER TABLE ai_issues ADD COLUMN IF NOT EXISTS expected_behavior TEXT;
    `);
    await client.query(`
      ALTER TABLE ai_issues ADD COLUMN IF NOT EXISTS actual_behavior TEXT;
    `);
    await client.query(`
      ALTER TABLE ai_issues ADD COLUMN IF NOT EXISTS reproduction_steps TEXT;
    `);

    client.release();

    console.log('✅ DB Migration: Tables initialized successfully.');
    return true;
  } catch (err) {
    console.error('❌ DB Migration Failed:', err);
    return false;
  }
}

module.exports = { runMigrations };

