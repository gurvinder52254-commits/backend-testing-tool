/**
 * ============================================================
 * microservices/start-all.js — Dev launcher
 * ============================================================
 * Runs the migration once, then starts every service as its own
 * child process (real separate processes — same as prod, just on
 * one machine). Output is prefixed per service. Ctrl+C stops all.
 *
 * For production you'd run each `npm run ms:<service>` on its own
 * host/replica set instead.
 * ============================================================
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..'); // backend-testing-tool
const node = process.execPath;

// Drop-in stack: gateway (API + WS on :3001) + worker (full engine).
// The frontend talks only to the gateway — no other services required.
// (ai-service / orchestrator / realtime are the alternative "fine-grained
//  split" and are intentionally not started in drop-in mode.)
const SERVICES = [
  { name: 'gateway', file: 'microservices/gateway/index.js' },
  { name: 'worker', file: 'microservices/worker/index.js' },
];

const children = [];

function run(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(node, [file], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`))));
    p.on('error', reject);
  });
}

function startService(svc) {
  const p = spawn(node, [svc.file], { cwd: ROOT, stdio: 'inherit' });
  children.push(p);
  p.on('exit', (code) => console.log(`[start-all] ${svc.name} exited with code ${code}`));
}

async function main() {
  console.log('[start-all] Running migration...');
  await run('microservices/shared/migrate.js');
  console.log('[start-all] Migration done. Starting services...\n');
  SERVICES.forEach(startService);

  const shutdown = () => {
    console.log('\n[start-all] Stopping all services...');
    children.forEach((c) => {
      try {
        c.kill('SIGINT');
      } catch (_) {}
    });
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[start-all] Failed:', err.message);
  process.exit(1);
});
