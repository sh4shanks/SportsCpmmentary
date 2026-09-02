# Real-Time Sports Commentary Service

A production-ready backend that polls a live sports API, detects significant match
incidents (goals, cards, substitutions) by diffing successive snapshots, and pushes
them to subscribers in real time over **Server-Sent Events**.

It is built around the three resilience concerns that make or break this class of
service: **concurrency** (one worker per match), **rate limiting** (a global budget
shared by every worker), and **circuit breaking** (per-match failure isolation).

| | |
|---|---|
| **Language / runtime** | TypeScript (strict) on Node.js 20+ |
| **Framework** | Fastify 4 |
| **Validation** | Zod |
| **Testing** | Jest + Supertest, against a controllable mock provider |
| **Packaging** | Docker + Docker Compose |

---

## Table of contents

- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Quick start with Docker](#quick-start-with-docker)
- [Running locally](#running-locally)
- [Environment variables](#environment-variables)
- [API documentation](#api-documentation)
- [How it works](#how-it-works)
  - [Concurrency model](#concurrency-model)
  - [Rate limiter](#rate-limiter)
  - [Circuit breaker](#circuit-breaker)
  - [Change detection](#change-detection)
- [Testing](#testing)
- [Design notes](#design-notes)

---

## Architecture

```
                                 ┌──────────────────────────────┐
   client ──── GET /events ────▶ │      SSE Endpoint            │
   client ──── GET /events ────▶ │   (hijacked long-lived HTTP) │
                                 └──────────────┬───────────────┘
                                                │ register / unregister
                                                ▼
                                 ┌──────────────────────────────┐
                                 │     Event Broadcaster        │
                                 │  fan-out + 20s keep-alive    │
                                 └──────────────▲───────────────┘
                                                │ broadcast(MatchEvent)
                                 ┌──────────────┴───────────────┐
                                 │     Change Detector          │
                                 │  previous snapshot ⟷ current │
                                 └──────────────▲───────────────┘
                                                │ diff
                       ┌────────────────────────┴───────────────┐
                       │        In-Memory State Manager         │
                       │        Map<matchId, MatchSnapshot>     │
                       └────────────────────────▲───────────────┘
                                                │ get / set
   POST/GET/DELETE                ┌─────────────┴────────────────┐
   /watch/matches  ─────────────▶ │       Polling Manager        │
                                  │  1 worker per matchId, no    │
                                  │  duplicates, clean shutdown  │
                                  └───┬──────────┬──────────┬────┘
                                      │          │          │
                             ┌────────▼──┐ ┌─────▼─────┐ ┌──▼────────┐
                             │ Worker A  │ │ Worker B  │ │ Worker N  │
                             │ ┌───────┐ │ │ ┌───────┐ │ │ ┌───────┐ │
                             │ │Breaker│ │ │ │Breaker│ │ │ │Breaker│ │   ← per-match state
                             │ └───┬───┘ │ │ └───┬───┘ │ │ └───┬───┘ │
                             └─────┼─────┘ └─────┼─────┘ └─────┼─────┘
                                   └─────────────┼─────────────┘
                                                 ▼
                                  ┌──────────────────────────────┐
                                  │  Global Rate Limiter         │   ← shared, 10 calls / 60s
                                  │  token bucket, FIFO waiters  │
                                  └──────────────┬───────────────┘
                                                 ▼
                                  ┌──────────────────────────────┐
                                  │  Sports API Client           │
                                  │  normalises provider payload │
                                  └──────────────┬───────────────┘
                                                 ▼
                                       External Sports API
                                  (mock container, or e.g.
                                   football-data.org / ESPN)
```

**Data flow:** `POST /watch/matches` → manager starts a worker → worker asks its
breaker for permission → waits for a rate-limiter token → fetches the match →
client normalises the payload → detector diffs it against the stored snapshot →
new events are broadcast to every SSE subscriber.

---

## Folder structure

```
sports-commentary-service/
├── src/
│   ├── api/
│   │   ├── controllers/
│   │   │   ├── HealthController.ts      # GET /health
│   │   │   ├── EventsController.ts      # GET /events (SSE)
│   │   │   └── WatchController.ts       # /watch/matches CRUD + validation
│   │   ├── middleware/
│   │   │   ├── errorHandler.ts          # JSON-only error boundary + 404 handler
│   │   │   └── requestLogger.ts         # structured request logging hooks
│   │   └── routes/
│   │       ├── health.ts
│   │       ├── events.ts
│   │       └── watch.ts
│   ├── clients/
│   │   └── SportsApiClient.ts           # ISportsApiClient + HTTP implementation
│   ├── config/
│   │   └── env.ts                       # Zod-validated configuration
│   ├── engine/
│   │   ├── PollingManager.ts            # worker lifecycle, watchlist ownership
│   │   ├── PollingWorker.ts             # one async polling loop per match
│   │   ├── RateLimiter.ts               # global token bucket
│   │   ├── CircuitBreaker.ts            # CLOSED / OPEN / HALF_OPEN state machine
│   │   ├── StateManager.ts              # in-memory snapshot repository
│   │   ├── ChangeDetector.ts            # snapshot diffing → domain events
│   │   └── EventBroadcaster.ts          # SSE client registry + fan-out
│   ├── mock/
│   │   ├── MockSportsApiServer.ts       # controllable fake provider
│   │   └── server.ts                    # standalone runner (compose service)
│   ├── models/
│   │   ├── MatchEvent.ts                # public event contract + SSE serializer
│   │   ├── MatchSnapshot.ts             # normalised internal match model
│   │   └── WatchMatch.ts                # watchlist request/response schemas
│   ├── utils/
│   │   ├── errors.ts                    # typed error hierarchy
│   │   ├── logger.ts                    # ILogger + JSON console logger
│   │   └── time.ts                      # Clock abstraction + abortable delay
│   ├── app.ts                           # composition root / Fastify factory
│   └── server.ts                        # process entrypoint, graceful shutdown
├── tests/
│   ├── helpers/testHarness.ts           # app+mock bootstrap, SSE test client
│   ├── mock/mockSportsApi.ts            # fixtures and mock controls
│   └── integration/
│       ├── health.test.ts
│       ├── watch.test.ts
│       ├── events.test.ts
│       ├── ratelimit.test.ts
│       └── circuitbreaker.test.ts
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── jest.config.js
├── tsconfig.json
├── tsconfig.build.json
├── instructions.md
└── package.json
```

---

## Quick start with Docker

```bash
docker compose up --build
```

This starts two containers:

| Service | Port | Purpose |
|---|---|---|
| `app` | 3000 | the commentary service |
| `mock-sports-api` | 4000 | a controllable fake provider that scripts a live match |

The mock appends a new incident to `match-123` every 20 seconds, so the stack is
fully demonstrable without any third-party API key:

```bash
# terminal 1 – subscribe
curl -N http://localhost:3000/events

# terminal 2 – start following the scripted match
curl -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' \
  -d '{"matchIds":["match-123"]}'
```

Within a couple of polling intervals, terminal 1 starts printing events:

```
: connected
id: match-123:goal:e1
event: goal
data: {"matchId":"match-123","team":"Arsenal","player":"Bukayo Saka","minute":12,"score":"1-0"}

: keep-alive
```

Wait for the health check to report ready before hitting the API:

```bash
docker compose up -d --wait
docker compose ps        # app should be "healthy"
```

To point the service at a real provider instead, set `EXTERNAL_API_URL` and
`API_KEY` in `.env` before starting.

---

## Running locally

```bash
npm install

cp .env.example .env     # optional; sensible defaults are built in

npm run mock             # terminal 1 – fake provider on :4000
npm run dev              # terminal 2 – service on :3000 with hot reload

npm test                 # integration suite
npm run build && npm start   # production build
```

---

## Environment variables

Every variable is validated by Zod at start-up; an invalid value fails fast with a
readable message instead of surfacing as a mysterious runtime error.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `EXTERNAL_API_URL` | `http://localhost:4000` | Base URL of the sports provider |
| `API_KEY` | *(empty)* | Sent as `X-Auth-Token` and `Authorization: Bearer` |
| `HTTP_TIMEOUT_MS` | `5000` | Per-request upstream timeout |
| `POLLING_INTERVAL_SECONDS` | `10` | Interval between polls of a single match |
| `RATE_LIMIT_MAX_REQUESTS` | `10` | Global request budget per window |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate-limit window length |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `3` | Consecutive failures that trip a breaker |
| `CIRCUIT_BREAKER_OPEN_SECONDS` | `60` | Backoff before a half-open probe |
| `SSE_KEEPALIVE_SECONDS` | `20` | Keep-alive comment interval |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |

---

## API documentation

### `GET /health`

```bash
curl -s http://localhost:3000/health
```

```json
{ "status": "ok", "uptimeSeconds": 42, "watching": 2, "sseClients": 1 }
```

### `GET /events` — Server-Sent Events stream

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`.

```bash
curl -N http://localhost:3000/events
```

Event frames follow the SSE specification exactly:

```
id: match-123:goal:e1
event: goal
data: {"matchId":"match-123","team":"Arsenal","player":"Bukayo Saka","minute":12,"score":"1-0"}

id: match-123:card:e2
event: card
data: {"matchId":"match-123","team":"Chelsea","player":"Reece James","minute":23,"cardType":"yellow"}

id: match-123:substitution:e4
event: substitution
data: {"matchId":"match-123","team":"Arsenal","playerIn":"Gabriel Jesus","playerOut":"Kai Havertz","minute":61}
```

Browser usage:

```js
const source = new EventSource('http://localhost:3000/events');
source.addEventListener('goal', (e) => console.log('GOAL', JSON.parse(e.data)));
source.addEventListener('card', (e) => console.log('CARD', JSON.parse(e.data)));
source.addEventListener('substitution', (e) => console.log('SUB', JSON.parse(e.data)));
```

### `POST /watch/matches` → `202 Accepted`

```bash
curl -i -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' \
  -d '{"matchIds":["match-123","match-456"]}'
```

```json
{
  "accepted": ["match-123", "match-456"],
  "alreadyWatching": [],
  "watching": ["match-123", "match-456"]
}
```

### `GET /watch/matches` → `200 OK`

```bash
curl -s http://localhost:3000/watch/matches
```

```json
{ "watching": ["match-123", "match-456"] }
```

### `DELETE /watch/matches` → `204 No Content`

```bash
curl -i -X DELETE http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' \
  -d '{"matchIds":["match-123"]}'
```

### Errors

Every failure — validation, malformed JSON, unknown route, unexpected exception —
is returned as JSON, never HTML:

```json
{
  "error": "Invalid request body",
  "details": [{ "path": "matchIds", "message": "matchIds is required" }]
}
```

---

## How it works

### Concurrency model

`PollingManager` owns a `Map<matchId, PollingWorker>`, which structurally
guarantees the "exactly one worker per match" rule — adding the same id twice is a
no-op, reported back as `alreadyWatching`.

Each worker is an independent `async` loop:

```
while (!aborted) {
  breaker.execute(async () => {
    await rateLimiter.acquire(signal);   // global budget
    return apiClient.fetchMatch(matchId, signal);
  });
  → detect changes → broadcast → store snapshot
  await delay(POLLING_INTERVAL, signal); // cancellable sleep
}
```

Cancellation is cooperative and uses an `AbortController` per worker, so
`DELETE /watch/matches` (and process shutdown) interrupts an in-flight sleep or a
queued rate-limit wait immediately, rather than after up to a minute.

### Rate limiter

A single `TokenBucketRateLimiter` instance is shared by every worker, so the limit
is global rather than per-match.

The twist compared with a naive bucket: **a token consumed at time `t` is returned
at exactly `t + window`**, instead of refilling the whole bucket on a fixed
schedule. Fixed-window refills permit a double burst across a boundary (10 calls at
59s plus 10 at 61s = 20 calls inside a 60 second *sliding* window). With
per-consumption regeneration, no sliding window can ever contain more than
`RATE_LIMIT_MAX_REQUESTS` requests — which is exactly the property the tests
assert.

Waiters are served strictly FIFO via a promise chain, so a worker cannot be starved
by later arrivals, and every wait is abortable.

### Circuit breaker

One breaker instance per worker, so a dead match cannot slow down a healthy one.

```
CLOSED ──3 consecutive failures──▶ OPEN ──60s elapsed──▶ HALF_OPEN
   ▲                                 ▲                      │
   └────── probe succeeds ───────────┴─── probe fails ──────┘
```

While `OPEN` the breaker fails fast: the operation is never invoked, so no upstream
request is made **and no rate-limiter token is consumed** — the budget stays
available for matches that are actually working. In `HALF_OPEN` exactly one probe
is admitted; success resets the failure count and closes the circuit, failure
re-opens it and restarts the timer.

Worker cancellation is explicitly excluded from the failure count, so stopping a
worker never trips its breaker.

### Change detection

The first poll of a match only establishes a baseline — otherwise every goal
already scored would be replayed as breaking news. Afterwards, `ChangeDetector`
compares timeline entries by a stable key (provider id when available, otherwise
type + minute + team + players) and emits anything new, sorted by minute.

A fallback covers providers that expose only an aggregate score: if the score moved
but no goal appeared on the timeline, a synthetic goal event is emitted so clients
still learn about it.

---

## Testing

```bash
npm test
```

The suite runs against a real HTTP mock of the provider (`MockSportsApiServer`),
so the client, worker, breaker and limiter are all exercised over the wire rather
than stubbed out.

| Spec | What it proves |
|---|---|
| `health.test.ts` | `200 {"status":"ok"}`, JSON 404s, production defaults are 10/60s and 3 failures/60s |
| `watch.test.ts` | 202 / 200 / 204 contract, no duplicate workers, concurrent polling of two matches, removal stops the loop, invalid payloads → JSON 400 |
| `events.test.ts` | SSE headers, goal **and** card **and** substitution delivery to a live subscriber, multi-client fan-out, no replay of historic incidents, disconnect cleanup |
| `ratelimit.test.ts` | 15 workers produce exactly 10 upstream calls; no 60s sliding window exceeds the budget; tokens regenerate one window later; queued waits abort cleanly |
| `circuitbreaker.test.ts` | Exactly 3 attempts, silence for the whole backoff, exactly one half-open probe, recovery, failure isolation between matches, full state machine on a fake clock |

Timers are compressed via config overrides (e.g. a 2 second backoff instead of 60)
so the suite finishes in seconds; the production defaults themselves are asserted
separately in `health.test.ts`.

---

## Design notes

- **Clean architecture / SOLID.** Every collaborator is an interface
  (`IRateLimiter`, `ICircuitBreaker`, `ISportsApiClient`, `IMatchStateRepository`,
  `IChangeDetector`, `IEventBroadcaster`, `IPollingManager`, `ILogger`) injected
  through constructors. `src/app.ts` is the only place where concrete classes are
  wired together, which is what makes the test harness a one-liner.
- **Repository pattern** for match state: swapping the in-memory `Map` for Redis to
  scale horizontally touches one class and nothing else.
- **Provider-agnostic boundary.** `SportsApiClient` normalises upstream payloads
  into `MatchSnapshot`, and `ChangeDetector` emits a fixed public contract, so the
  SSE stream is unaffected by provider quirks.
- **Injected clock.** `CircuitBreaker` and `TokenBucketRateLimiter` take a `Clock`,
  making their time-dependent behaviour testable without waiting a real minute.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` close the Fastify server, abort every
  worker and end every SSE connection, so containers stop instantly.
- **Security hygiene.** Match ids are schema-restricted before being interpolated
  into upstream URLs, the runtime image drops to the non-root `node` user, and
  5xx responses never leak internals to the client.
