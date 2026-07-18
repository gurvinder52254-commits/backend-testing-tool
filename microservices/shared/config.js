/**
 * ============================================================
 * microservices/shared/config.js — Central Config
 * ============================================================
 * Single source of truth for every service. Reads the SAME
 * .env that the existing monolith uses (../../.env), so no
 * duplicate secrets. All values have safe local defaults.
 * ============================================================
 */

const path = require('path');

// Load the monolith's .env (shared secrets: DATABASE_URL, GEMINI/GROQ keys, etc.)
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const config = {
  // ---- Shared PostgreSQL (same DB as the monolith) ----
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/webtest',

  // ---- Service ports (all different from the monolith's 3001) ----
  ports: {
    gateway: num(process.env.MS_GATEWAY_PORT, 4000),
    realtime: num(process.env.MS_REALTIME_PORT, 4001),
    ai: num(process.env.MS_AI_PORT, 4002),
    orchestratorHealth: num(process.env.MS_ORCHESTRATOR_HEALTH_PORT, 4003),
    workerHealth: num(process.env.MS_WORKER_HEALTH_PORT, 4004),
  },

  // ---- Internal service URLs (used for east-west calls) ----
  urls: {
    ai: process.env.MS_AI_URL || `http://127.0.0.1:${num(process.env.MS_AI_PORT, 4002)}`,
  },

  // ---- Drop-in mode: gateway replaces the monolith on the SAME port (3001)
  // so the existing frontend works unchanged. The worker POSTs engine events
  // back to the gateway's internal endpoint for WS broadcast. ----
  dropinPort: num(process.env.MS_DROPIN_PORT, 3001),
  internalBroadcastUrl:
    process.env.MS_INTERNAL_BROADCAST_URL ||
    `http://127.0.0.1:${num(process.env.MS_DROPIN_PORT, 3001)}/internal/broadcast`,

  // ---- Queue (pg-boss on the shared Postgres — no Redis needed) ----
  queues: {
    scan: 'scan',
    discovery: 'discovery',
    pageTest: 'page-test',
    finalize: 'finalize',
  },

  // ---- Concurrency knobs ----
  concurrency: {
    // How many scans a single orchestrator node coordinates at once
    scan: num(process.env.MS_SCAN_CONCURRENCY, 3),
    // How many discovery crawls run at once
    discovery: num(process.env.MS_DISCOVERY_CONCURRENCY, 2),
    // How many pages a single worker node tests in parallel (bounded browsers)
    pageTest: num(process.env.MS_PAGE_CONCURRENCY, 3),
    finalize: num(process.env.MS_FINALIZE_CONCURRENCY, 3),
  },

  // ---- Safety caps ----
  limits: {
    // Hard cap on how many discovered pages actually get tested per scan
    maxPages: num(process.env.MS_MAX_PAGES, 40),
    pageNavTimeoutMs: num(process.env.MS_PAGE_NAV_TIMEOUT_MS, 35000),
    aiTimeoutMs: num(process.env.MS_AI_TIMEOUT_MS, 120000),
  },

  // ---- Auth (identical defaults to middleware/authMiddleware.js) ----
  auth: {
    sessionSecret: process.env.SESSION_SECRET || 'webtest_secret_default_key_123456',
    googleClientId:
      process.env.GOOGLE_CLIENT_ID ||
      '272763569916-bhpu0j2v70tvkpj9dmppjehtpdn4f3ec.apps.googleusercontent.com',
  },

  // ---- Shared reports directory (same folder the monolith serves) ----
  reportsDir: path.join(__dirname, '..', '..', 'reports'),

  // Whether the AI step is enabled at all. Off by default so smoke tests /
  // local runs never trigger paid Gemini/Groq calls unless explicitly enabled.
  aiEnabled: process.env.MS_AI_ENABLED === 'true',
};

module.exports = config;
