# Microservices Architecture (Phase 1 → runnable)

A microservices decomposition of the website-testing engine that runs
**alongside** the existing monolith without changing it. It reuses the
existing engine code (`playwrightTester`, `geminiAnalyzer`, `groqAnalyzer`,
`models/*`) and uses the **existing PostgreSQL** as both the durable job
queue (via `pg-boss`) and the realtime bus (via `LISTEN/NOTIFY`) — so
**no Redis / no extra infrastructure** is required to run it.

The monolith keeps running unchanged on port **3001**. These services run
on **4000–4004**.

## Services

| Service | Port | Role |
|---|---|---|
| **gateway** | 4000 | Public REST API. Auth, validates + **enqueues** scans, serves reports & screenshots. Stateless. |
| **realtime** | 4001 | WebSocket gateway. Per-test rooms + auth (no global broadcast). Delivers events via `LISTEN/NOTIFY` with durable replay. |
| **ai-service** | 4002 | Only holder of the Gemini/Groq keys. Runs both in parallel. Off by default (`MS_AI_ENABLED`). |
| **orchestrator** | 4003 (health) | Coordinates lifecycle: `scan` → discovery; `finalize` → assemble + save report. |
| **worker** | 4004 (health) | Browser-bound. `discovery` (crawl + fan-out) and `page-test` (one page per job, parallel). |

Shared Postgres carries: `pgboss` schema (queue), `scan_progress` /
`scan_pages` / `scan_events` (new, additive), plus the existing
`users` / `reports`. It also creates `link_status_cache` (a table the
engine expected but the monolith migration never created).

## Flow

```
client ──POST /start-test──► gateway ──enqueue "scan"──► orchestrator
                                                            │ enqueue "discovery"
                                                            ▼
                                                         worker (crawl, cap, fan-out)
                                                            │ enqueue N × "page-test"
                                                            ▼
                                                worker (per page) ──HTTP──► ai-service
                                                            │ save page + emit event
                                                            │ last page? enqueue "finalize"
                                                            ▼
                                                     orchestrator (assemble → reports table)
                                                            │ emit "test-complete"
client ◄──WebSocket (per-test room)──── realtime ◄── LISTEN/NOTIFY ◄── scan_events
```

## Run

```bash
# 1. Ensure DATABASE_URL is set in ../.env (same DB as the monolith)
# 2. One-time (also runs automatically via ms:all):
npm run ms:migrate

# 3a. Everything at once (separate child processes):
npm run ms:all

# 3b. …or each service in its own terminal (prod-style):
npm run ms:ai
npm run ms:orchestrator
npm run ms:worker
npm run ms:realtime
npm run ms:gateway
```

Health checks: `GET :4000/api/health`, `:4001/health`, `:4002/health`,
`:4003/health`, `:4004/health`.

### Enable AI (costs money)

AI is **disabled by default** so local runs never trigger paid Gemini/Groq
calls. To turn it on, set `MS_AI_ENABLED=true` (and valid keys) in `../.env`.
With it off, pages are still crawled, tested, screenshotted, and scored
structurally — only the LLM score/inventory is skipped.

### WebSocket protocol (realtime :4001)

```jsonc
// client → server
{ "type": "subscribe", "testId": "abc12345", "token": "<session-or-google-token>", "lastEventId": 0 }
// server → client
{ "type": "subscribed", "testId": "abc12345" }
{ "type": "page-complete", "testId": "abc12345", "eventId": 7, "pageIndex": 2, "result": { ... } }
{ "type": "test-complete", "testId": "abc12345", "eventId": 20, "overallScore": 78 }
```

## Production scale-up (not required to run)

- Swap `shared/queue.js` for a BullMQ/Redis implementation (same
  `getBoss/send/work` surface) when Postgres-as-queue is outgrown.
- Move screenshots to S3/MinIO and hand out signed URLs.
- Run each service as its own replica set; put a remote Chromium grid
  (Browserless) behind the worker.
- Add OpenTelemetry tracing + a circuit breaker around the AI service.

## What this fixes from the monolith

- Durable state (survives restart) instead of in-memory `activeTests` / queue.
- Bounded, parallel page testing (one page = one job) vs sequential.
- WebSocket auth + per-test rooms (no cross-tenant leak, no global broadcast).
- AI key isolation in one service.
- Missing `link_status_cache` table created.
- God-function split into small, single-responsibility modules.
