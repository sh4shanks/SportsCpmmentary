# Instructions

Setup, run, test and verification guide for the **Real-Time Sports Commentary
Service**.

---

## 1. Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 20 or newer (the service uses the global `fetch`) |
| npm | 9 or newer |
| Docker + Docker Compose | any recent version (Compose v2 syntax) |

---

## 2. Installation

```bash
npm install
```

Optionally create a local environment file (the service also runs with built-in
defaults):

```bash
cp .env.example .env
```

---

## 3. Running with Docker

```bash
docker compose up --build
```

Two containers start:

- **`mock-sports-api`** on `:4000` — a controllable fake provider that scripts a
  live match, so nothing external is required.
- **`app`** on `:3000` — the commentary service.

To wait for health checks and run detached:

```bash
docker compose up -d --build --wait
docker compose ps          # app must report "healthy"
docker compose logs -f app
docker compose down
```

Point the service at a real provider by setting `EXTERNAL_API_URL` and `API_KEY`
in `.env` before `docker compose up`.

---

## 4. Running locally (without Docker)

```bash
# terminal 1 — fake provider on :4000
npm run mock

# terminal 2 — service on :3000 with hot reload
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Other scripts: `npm run typecheck`, `npm run clean`.

---

## 5. Testing

```bash
npm test
```

Runs the Jest + Supertest integration suite in band against an in-process mock of
the upstream provider. Expected output: five suites
(`health`, `watch`, `events`, `ratelimit`, `circuitbreaker`), all passing.

---

## 6. Environment variables

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
| `MOCK_API_PORT` | `4000` | Port of the standalone mock provider |
| `MOCK_EVENT_INTERVAL_SECONDS` | `20` | How often the mock scripts a new incident |

All variables are validated with Zod at start-up; an invalid value aborts the boot
with a readable message.

---

## 7. Verification steps

Start the stack first: `docker compose up -d --build --wait`.

### 7.1 Health endpoint

```bash
curl -i http://localhost:3000/health
```

Expected: `200 OK`, `Content-Type: application/json`, body containing
`{"status":"ok", ...}`. `docker compose ps` shows the `app` container as
`healthy`.

### 7.2 Watchlist API

```bash
curl -i -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' -d '{"matchIds":["match-123","match-456"]}'
# → 202 Accepted

curl -s http://localhost:3000/watch/matches
# → {"watching":["match-123","match-456"]}

curl -i -X DELETE http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' -d '{"matchIds":["match-456"]}'
# → 204 No Content

curl -s http://localhost:3000/watch/matches
# → {"watching":["match-123"]}   (match-456 is gone)

curl -i -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' -d '{"matchIds":[]}'
# → 400 with a JSON body: {"error":"Invalid request body","details":[...]}
```

### 7.3 SSE streaming

```bash
# terminal 1
curl -N -i http://localhost:3000/events
```

Expected headers: `content-type: text/event-stream`, `cache-control: no-cache`,
`connection: keep-alive`, followed by `: connected` and a `: keep-alive` comment
every 20 seconds.

```bash
# terminal 2
curl -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' -d '{"matchIds":["match-123"]}'
```

The mock scripts a new incident every 20 seconds, so terminal 1 begins printing
frames such as:

```
event: goal
data: {"matchId":"match-123","team":"Arsenal","player":"Bukayo Saka","minute":12,"score":"1-0"}
```

Open a second `curl -N http://localhost:3000/events` to confirm both subscribers
receive the same event (fan-out).

### 7.4 Concurrent polling

```bash
curl -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' -d '{"matchIds":["match-123","match-456"]}'

sleep 60
curl -s "http://localhost:4000/_control/requests" | head -c 400
```

The mock's request log contains entries for **both** match ids, proving the two
polling loops run concurrently.

### 7.5 Rate limiter

```bash
curl -X POST http://localhost:4000/_control/reset

MATCHES=$(node -e "console.log(JSON.stringify({matchIds:Array.from({length:15},(_,i)=>'rl-'+i)}))")
curl -X POST http://localhost:3000/watch/matches -H 'Content-Type: application/json' -d "$MATCHES"

sleep 150
curl -s "http://localhost:4000/_control/requests" | \
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{
    const t=JSON.parse(s).requests.map(r=>r.timestamp).sort((a,b)=>a-b);
    let max=0; for(let i=0;i<t.length;i++){let n=0;for(let j=i;j<t.length&&t[j]-t[i]<60000;j++)n++;max=Math.max(max,n);}
    console.log('total',t.length,'max per 60s window',max);})"
```

Expected: the maximum number of requests in any 60 second sliding window is
**≤ 10**, even though 15 workers are competing for the budget.

### 7.6 Circuit breaker

```bash
curl -X POST http://localhost:4000/_control/reset
curl -X PUT  "http://localhost:4000/_control/failures/match-789?status=503"
curl -X POST http://localhost:3000/watch/matches \
  -H 'Content-Type: application/json' -d '{"matchIds":["match-789"]}'

sleep 45
curl -s "http://localhost:4000/_control/requests?matchId=match-789" | grep -o timestamp | wc -l
# → 3   (breaker opened after 3 consecutive failures)

sleep 45
curl -s "http://localhost:4000/_control/requests?matchId=match-789" | grep -o timestamp | wc -l
# → 4   (exactly one half-open probe after the 60s backoff)

curl -X DELETE http://localhost:4000/_control/failures/match-789
sleep 90
curl -s "http://localhost:4000/_control/requests?matchId=match-789" | grep -o timestamp | wc -l
# → > 4 (probe succeeded, circuit closed, polling resumed)
```

Setting `CIRCUIT_BREAKER_OPEN_SECONDS=5` and `POLLING_INTERVAL_SECONDS=1` in
`.env` makes this observable in seconds instead of minutes.

---

## 8. Submission checklist

- [x] `docker-compose.yml` at the repository root, with a working `healthcheck`
      on the application service
- [x] `.env.example` at the repository root documenting `PORT`,
      `EXTERNAL_API_URL`, `POLLING_INTERVAL_SECONDS`, `API_KEY` and all other
      variables
- [x] `GET /health` returns `200` with `{"status":"ok"}`
- [x] `GET /events` streams SSE with `text/event-stream`, `keep-alive` and
      `no-cache` headers
- [x] `POST /watch/matches` → `202`, `GET /watch/matches` → `200 {"watching":[...]}`,
      `DELETE /watch/matches` → `204`
- [x] One concurrent polling worker per watched match, never duplicated
- [x] Global rate limit of 10 upstream calls per 60 seconds across all workers
- [x] Goal / card / substitution detection with the specified event schema
- [x] Per-worker circuit breaker: 3 failures → OPEN → 60s → HALF_OPEN → recovery
- [x] Integration tests in `tests/` using a mocked provider, including the
      end-to-end "add match → mock a goal → SSE client receives it" scenario
- [x] `npm test`, `npm run build` and `docker compose up` all documented
