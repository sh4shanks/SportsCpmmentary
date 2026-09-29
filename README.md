# Sports Commentary Service

### Real-Time Sports Intelligence & Commentary Engine

A production-grade, highly resilient sports event streaming, commentary generation, and monitoring platform built on Node.js, TypeScript, and Fastify.

The service monitors sports matches across upstream providers, detects in-match incidents (goals, yellow/red cards, substitutions) by diffing successive snapshots, translates them into human-readable narrative commentary across multiple broadcast styles, and streams them in real time over **Server-Sent Events (SSE)** to an interactive **Live Match Center**.

---

## 1. End-to-End Architecture

```
                    ┌────────────────────────────────────────────────────────┐
                    │               LIVE MATCH CENTER DASHBOARD              │
                    │         HTML / CSS / Live SSE Commentary Feed          │
                    └───────────────────────────▲────────────────────────────┘
                                                │ text/event-stream (SSE)
                                                │ ?format=commentary&style=...
                                 ┌──────────────┴───────────────┐
   Subscriber ── GET /events ──▶ │      SSE Stream Gateway      │
                                 │   (hijacked HTTP connection) │
                                 └──────────────┬───────────────┘
                                                │ register / filter / unregister
                                                ▼
                                 ┌──────────────────────────────┐
                                 │      Event Broadcaster       │
                                 │  fan-out + 20s keep-alives   │
                                 └──────────────▲───────────────┘
                                                │ broadcast(MatchEvent)
                                 ┌──────────────┴───────────────┐
                                 │      Commentary Engine       │
                                 │  narrative templates + styles│
                                 │  severity + momentum + summary
                                 └──────────────▲───────────────┘
                                                │ MatchEvent
                                 ┌──────────────┴───────────────┐
                                 │       Change Detector        │
                                 │  previous snapshot ⟷ current │
                                 └──────────────▲───────────────┘
                                                │ diff
                        ┌───────────────────────┴────────────────┐
                        │        In-Memory State Manager         │
                        │      Snapshots + Match Timelines       │
                        └───────────────────────▲────────────────┘
                                                │ get / set
   REST API             ┌───────────────────────┴────────────────┐
   /watch/matches ────▶ │        Polling Manager                 │
                        │   1:1 worker-to-match, deduplication,  │
                        │   clean lifecycle & state eviction     │
                        └───┬──────────┬──────────┬──────────────┘
                            │          │          │
                   ┌────────▼──┐ ┌─────▼─────┐ ┌──▼────────┐
                   │ Worker A  │ │ Worker B  │ │ Worker N  │
                   │ ┌───────┐ │ │ ┌───────┐ │ │ ┌───────┐ │
                   │ │Breaker│ │ │ │Breaker│ │ │ │Breaker│ │   ← Per-match Circuit Breakers
                   │ └───┬───┘ │ │ └───┬───┘ │ │ └───┬───┘ │     (CLOSED/OPEN/HALF-OPEN)
                   └─────┼─────┴─┴─────┼─────┴─┴─────┼─────┘
                         └─────────────┼─────────────┘
                                       │ acquire() [FIFO promise-chain token bucket]
                        ┌──────────────▼───────────────┐
                        │     Global Rate Limiter      │  ← Strict sliding-window rate limit
                        └──────────────┬───────────────┘    (shared across all workers)
                                       │
                                       ▼
                        ┌──────────────────────────────┐
                        │      Sports API Provider     │
                        │   (Live API or In-Process    │
                        │    MockSportsApiServer)      │
                        └──────────────────────────────┘
```

---

## 2. Why Each Component Exists

1. **Global Rate Limiter (`RateLimiter.ts`)**:
   Upstream sports data providers impose strict rate limits (e.g. 10 requests per 60-second sliding window). If 15 workers independently polled their matches every 5 seconds, they would generate 180 requests/minute and receive HTTP 429 penalties. The Global Rate Limiter coordinates all concurrent polling workers using a FIFO promise chain with sliding-window token regeneration and interval pacing to prevent micro-bursts.

2. **Concurrent Polling Workers (`PollingWorker.ts`) & Polling Manager (`PollingManager.ts`)**:
   Maintains a strict 1:1 worker-to-match ratio. Each worker owns an independent polling loop with graceful cancellation via `AbortController`. Duplicate watch requests are ignored, and removing a match stops its loop and flushes its cached state.

3. **Per-Match Circuit Breakers (`CircuitBreaker.ts`)**:
   If an upstream match endpoint returns `503 Service Unavailable`, times out, or errors out, an isolated circuit breaker trips (`CLOSED -> OPEN -> HALF_OPEN -> CLOSED`). When `OPEN`, the worker fails fast *before* acquiring a rate limiter token. This guarantees zero rate limit tokens are wasted on failing fixtures and ensures a broken match never degrades healthy matches.

4. **In-Memory State Repository & Match Timelines (`StateManager.ts`)**:
   Maintains the latest snapshot of each match along with a chronological timeline of detected incidents. Timelines reset cleanly on process restart or match unwatch without requiring an external database.

5. **Change Detector (`ChangeDetector.ts`)**:
   Establishes an initial silent baseline on first poll to prevent replaying historic match goals. On subsequent polls, it diffs incoming provider data against the cached baseline to detect goals, yellow cards, red cards, and substitutions.

6. **Commentary Engine (`CommentaryEngine.ts`)**:
   Translates raw structured events into contextual, human-readable commentary narratives. Supports three deterministic broadcast styles (`standard`, `concise`, `professional`), categorizes event severity (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`), calculates engine-generated match momentum, and produces full-time match summaries.

7. **Event Broadcaster (`EventBroadcaster.ts`) & SSE Gateway (`EventsController.ts`)**:
   Maintains long-lived HTTP Server-Sent Events connections using `reply.hijack()`, proxy unbuffering headers (`X-Accel-Buffering: no`), and periodic 20-second heartbeats (`: keep-alive`). Supports match-filtering (`?matchId=...`) and rich commentary formatting (`?format=commentary`).

8. **Live Match Center (`RootController.ts`)**:
   A comprehensive real-time dashboard featuring multi-match scoreboards, momentum indicators, full-time summaries, live commentary feed with client-side filtering, interactive upstream match simulator, and complete observability telemetry.

---

## 3. Commentary Engine & Broadcast Styles

The **Commentary Engine** supports deterministic, offline-capable templates:

| Event Type | Severity | Standard Style | Concise Style | Professional Broadcast Style |
|---|---|---|---|---|
| **GOAL** | `CRITICAL` | `GOAL! Arsenal take the lead through Bukayo Saka in the 67th minute! (2-1)` | `67' — GOAL Arsenal. Bukayo Saka (2-1).` | `Arsenal move ahead following a successful attacking sequence finished by Bukayo Saka in minute 67 (2-1).` |
| **RED CARD** | `HIGH` | `RED CARD! Enzo Fernandez (Chelsea) is sent off in the 82nd minute!` | `82' — RED CARD Enzo Fernandez (Chelsea).` | `Chelsea are reduced to 10 players as Enzo Fernandez receives a straight red card in minute 82.` |
| **YELLOW CARD** | `MEDIUM` | `YELLOW CARD! Reece James (Chelsea) receives a booking in the 45th minute.` | `45' — YELLOW CARD Reece James (Chelsea).` | `Reece James of Chelsea is shown a yellow card by the referee for a disciplinary infraction in minute 45.` |
| **SUBSTITUTION** | `LOW` | `SUBSTITUTION: Arsenal bring on Gabriel Jesus to replace Kai Havertz in the 60th minute.` | `60' — SUB Arsenal: Gabriel Jesus on for Kai Havertz.` | `Arsenal execute a tactical alteration: Gabriel Jesus enters the pitch in place of Kai Havertz (minute 60).` |

### Extensible Event Severity Hierarchy
* `CRITICAL`: Goals, match suspensions
* `HIGH`: Red cards, penalties, VAR reviews
* `MEDIUM`: Yellow cards, full-time whistle, match resumptions
* `LOW`: Substitutions, corners, offsides, injuries, kickoff, half-time

---

## 4. Match Momentum & Full-Time Summaries

### Engine-Generated Momentum
* Clearly labeled: **"Engine-generated momentum"**
* Calculated purely from actual detected events:
  * Baseline: 50% / 50%
  * Goal: +25% for scoring team, -25% for conceding team
  * Red card: -30% penalty for penalized team
  * Yellow card: -8% penalty for booked team
  * Substitution: +4% tactical lift for substituting team
  * Score margin: +5% per goal advantage
  * Clamped to 10% - 90% bounded range

### Full-Time Summaries
When a match reaches `FINISHED` or `FULL_TIME`:
* Final scoreline & victor headline
* List of all goals with minutes and scorers
* Total cards (yellow and red)
* Total substitutions executed
* Total verified incident count

---

## 5. API Reference

| Method | Endpoint | Description | Sample Command |
|---|---|---|---|
| `GET` | `/` | Live Match Center & Operations Console | `curl http://localhost:3000/` |
| `GET` | `/health` | Lightweight liveness probe & connection counts | `curl http://localhost:3000/health` |
| `GET` | `/stats` | Telemetry: metrics, rate limiter, circuit breakers, watchlist & momentum | `curl http://localhost:3000/stats` |
| `GET` | `/events` | Server-Sent Events stream (legacy format) | `curl -N http://localhost:3000/events` |
| `GET` | `/events?format=commentary` | SSE stream with rich commentary payload | `curl -N "http://localhost:3000/events?format=commentary"` |
| `GET` | `/events?matchId=match-123` | SSE stream filtered to a single match | `curl -N "http://localhost:3000/events?matchId=match-123"` |
| `GET` | `/watch/matches` | List watched match IDs | `curl http://localhost:3000/watch/matches` |
| `POST` | `/watch/matches` | Add matches to watch (`{"matchIds": [...]}`) | `curl -X POST http://localhost:3000/watch/matches -H "Content-Type: application/json" -d '{"matchIds":["match-123"]}'` |
| `DELETE` | `/watch/matches` | Remove matches from watch (`{"matchIds": [...]}`) | `curl -X DELETE http://localhost:3000/watch/matches -H "Content-Type: application/json" -d '{"matchIds":["match-123"]}'` |
| `POST` | `/simulation/event` | Inject incident into upstream mock provider | `curl -X POST http://localhost:3000/simulation/event -H "Content-Type: application/json" -d '{"matchId":"match-123","type":"goal"}'` |
| `POST` | `/simulation/status` | Update match status on upstream provider | `curl -X POST http://localhost:3000/simulation/status -H "Content-Type: application/json" -d '{"matchId":"match-123","status":"FINISHED"}'` |
| `POST` | `/simulation/failure` | Inject upstream HTTP 503 failure (breaker test) | `curl -X POST http://localhost:3000/simulation/failure -H "Content-Type: application/json" -d '{"matchId":"match-123","status":503}'` |
| `DELETE` | `/simulation/failure` | Clear upstream failure (breaker recovery) | `curl -X DELETE "http://localhost:3000/simulation/failure?matchId=match-123"` |

---

## 6. Example Server-Sent Events

### Commentary Format (`GET /events?format=commentary`)
```http
id: match-123:goal:goal-1
event: goal
data: {"eventId":"match-123:goal:goal-1","matchId":"match-123","type":"GOAL","severity":"CRITICAL","minute":67,"team":"Arsenal","commentary":"GOAL! Arsenal take the lead through Bukayo Saka in the 67th minute! (2-1)","timestamp":"2026-09-29T12:00:00.000Z"}
```

### Legacy Format (`GET /events` - Backwards Compatible)
```http
id: match-123:goal:goal-1
event: goal
data: {"matchId":"match-123","team":"Arsenal","player":"Bukayo Saka","minute":67,"score":"2-1"}
```

---

## 7. Installation & Running

### Prerequisites
* Node.js >= 20.0.0
* npm >= 9.0.0
* (Optional) Docker & Docker Compose

### Local Development
```bash
npm install
npm run build
npm run dev
```
In development mode, the service automatically boots an embedded mock sports API server on port 4000 if no external provider is running and pre-watches default fixture `match-123`.

Visit `http://localhost:3000` to open the **Live Match Center**.

### Running Standalone Mock Provider
```bash
# Terminal 1 - Mock Sports API on port 4000
npm run mock

# Terminal 2 - Commentary Service on port 3000
npm start
```

### Running with Docker Compose
```bash
docker compose up --build
```
Spawns two containers:
1. `mock-sports-api` on port 4000
2. `app` on port 3000

---

## 8. Verification & Testing

The test suite runs with Jest in-band against ephemeral mock sports servers:

```bash
npm test
```

### Test Coverage (7 Suites, 42 Tests Passing)
1. **`commentary.test.ts` (11 tests)**: Commentary generation across all styles, severity classification, match momentum calculation, full-time summaries, timeline storage, SSE commentary payload, match filtering, and end-to-end simulation.
2. **`circuitbreaker.test.ts` (4 tests)**: Failure threshold trips, backoff timeout, half-open probe, recovery, and isolation between matches.
3. **`ratelimit.test.ts` (6 tests)**: Strict 10 requests / 60s sliding window compliance across concurrent workers, single-window regeneration, queue abortion, capacity=1 limits, and race condition immunity.
4. **`watch.test.ts` (5 tests)**: Watchlist CRUD (202, 200, 204), duplicate worker rejection, concurrent polling loops, and worker shutdown.
5. **`events.test.ts` (7 tests)**: SSE streaming headers, score change goal broadcasts, card broadcasts, substitution broadcasts, multi-client fan-out, silent baseline validation, and client disconnect cleanup.
6. **`stats.test.ts` (3 tests)**: Operational telemetry, worker states, and incident counters.
7. **`health.test.ts` (6 tests)**: Liveness probe, subscriber counting, JSON 404 responses, production default configurations, and HTML / JSON root dashboard responses.
