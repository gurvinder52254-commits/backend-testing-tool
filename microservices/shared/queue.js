/**
 * ============================================================
 * microservices/shared/queue.js — Durable job queue (pg-boss)
 * ============================================================
 * Uses pg-boss on the EXISTING PostgreSQL (no Redis required).
 * pg-boss keeps its own `pgboss` schema, so it never touches
 * the app's tables. This is the message bus between services.
 *
 * Production note: to scale beyond a single Postgres, swap this
 * one file for a BullMQ/Redis implementation with the same
 * getBoss()/send()/work() surface — nothing else changes.
 * ============================================================
 */

const { PgBoss } = require('pg-boss');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('queue');

let bossPromise = null;

function buildBoss() {
  const isLocal =
    config.databaseUrl.includes('localhost') || config.databaseUrl.includes('127.0.0.1');
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  boss.on('error', (err) => log.error('pg-boss error:', err.message));
  return boss;
}

/**
 * Returns a started pg-boss singleton with all queues created.
 */
async function getBoss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = buildBoss();
      await boss.start();
      // Queues must exist before send()/work() in pg-boss v10+.
      for (const name of Object.values(config.queues)) {
        await boss.createQueue(name);
      }
      log.ok('pg-boss started; queues ready:', Object.values(config.queues).join(', '));
      return boss;
    })().catch((err) => {
      bossPromise = null; // allow retry on next call
      throw err;
    });
  }
  return bossPromise;
}

/**
 * Enqueue a job. Returns the job id.
 */
async function send(queueName, data, options = {}) {
  const boss = await getBoss();
  return boss.send(queueName, data, {
    retryLimit: 2,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    ...options,
  });
}

/**
 * Register a worker. `handler(data, job)` is called once per job.
 * pg-boss v12 hands the work callback an array of jobs (batch); we
 * unwrap it so callers deal with one job at a time.
 */
async function work(queueName, { concurrency = 1 } = {}, handler) {
  const boss = await getBoss();
  return boss.work(
    queueName,
    { localConcurrency: concurrency, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await handler(job.data, job);
      }
    }
  );
}

async function stop() {
  if (bossPromise) {
    try {
      const boss = await bossPromise;
      await boss.stop({ graceful: true, timeout: 10000 });
    } catch (_) {
      /* ignore */
    }
    bossPromise = null;
  }
}

module.exports = { getBoss, send, work, stop };
