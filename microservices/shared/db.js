/**
 * ============================================================
 * microservices/shared/db.js — DB access
 * ============================================================
 * Reuses the monolith's connection pool (../../config/db) so
 * both systems share the exact same Postgres configuration.
 * Also exposes a factory for a dedicated LISTEN/NOTIFY client
 * (pooled clients can't hold a long-lived LISTEN).
 * ============================================================
 */

// IMPORTANT: require ./config FIRST — it runs dotenv so DATABASE_URL is set
// in process.env BEFORE the monolith's ../../config/db reads it at load time.
const config = require('./config');
const { Client } = require('pg');
const { pool } = require('../../config/db');

/**
 * Creates a standalone client for LISTEN/NOTIFY. Caller owns its lifecycle.
 */
function createListenerClient() {
  const isLocal =
    config.databaseUrl.includes('localhost') || config.databaseUrl.includes('127.0.0.1');
  return new Client({
    connectionString: config.databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
}

module.exports = { pool, createListenerClient };
