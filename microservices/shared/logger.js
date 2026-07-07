/**
 * ============================================================
 * microservices/shared/logger.js — Tiny tagged logger
 * ============================================================
 * No extra dependency. Each service creates a logger with its
 * own tag so multiplexed output (ms:all) is readable.
 * ============================================================
 */

function ts() {
  return new Date().toISOString();
}

function createLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    info: (...a) => console.log(ts(), prefix, ...a),
    warn: (...a) => console.warn(ts(), prefix, '⚠️', ...a),
    error: (...a) => console.error(ts(), prefix, '❌', ...a),
    ok: (...a) => console.log(ts(), prefix, '✅', ...a),
  };
}

module.exports = { createLogger };
