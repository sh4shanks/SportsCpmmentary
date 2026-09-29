import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env';
import type { IEventBroadcaster } from '../../engine/EventBroadcaster';
import type { IPollingManager } from '../../engine/PollingManager';
import type { IRateLimiter } from '../../engine/RateLimiter';
import type { IMatchStateRepository } from '../../engine/StateManager';
import type { IMetricsCollector } from '../../engine/MetricsCollector';
import type { ICommentaryEngine } from '../../engine/CommentaryEngine';
import { CircuitState } from '../../engine/CircuitBreaker';

export class RootController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: AppConfig,
    private readonly pollingManager: IPollingManager,
    private readonly broadcaster: IEventBroadcaster,
    private readonly rateLimiter: IRateLimiter,
    private readonly stateRepository: IMatchStateRepository,
    private readonly metrics: IMetricsCollector,
    private readonly commentaryEngine?: ICommentaryEngine,
  ) {}

  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const workerCount = this.pollingManager.workerCount;
    const clientCount = this.broadcaster.clientCount;
    const watchedMatches = this.pollingManager.list();
    const availableTokens = this.rateLimiter.availableTokens;
    const capacity = this.config.rateLimitMaxRequests;
    const consumedTokens = Math.max(0, capacity - availableTokens);
    const eventCounters = this.metrics.getEventCounters();
    const pollingCounters = this.metrics.getPollingCounters();

    const data = {
      name: 'sports-commentary-service',
      title: 'Sports Commentary Service — Real-Time Sports Intelligence & Commentary Engine',
      version: '1.0.0',
      status: 'ok',
      uptimeSeconds,
      metrics: {
        matchesWatched: workerCount,
        activeWorkers: workerCount,
        connectedSseClients: clientCount,
        eventsDetected: eventCounters.total,
        apiRequests: pollingCounters.totalPolls,
        rateLimit: {
          consumed: consumedTokens,
          capacity,
          windowSeconds: this.config.rateLimitWindowSeconds,
        },
      },
      watchedMatchIds: watchedMatches,
      endpoints: [
        { method: 'GET', path: '/', description: 'Sports Commentary Service Live Match Center & Console' },
        { method: 'GET', path: '/health', description: 'Liveness & readiness probe' },
        { method: 'GET', path: '/stats', description: 'Operational telemetry, commentary metrics, rate limiter & circuit breaker states' },
        { method: 'GET', path: '/events', description: 'Server-Sent Events (SSE) real-time incident & commentary stream' },
        { method: 'GET', path: '/watch/matches', description: 'List currently watched match IDs' },
        { method: 'POST', path: '/watch/matches', description: 'Add matches to watch (JSON: {"matchIds": [...]})' },
        { method: 'DELETE', path: '/watch/matches', description: 'Remove matches from watch (JSON: {"matchIds": [...]})' },
        { method: 'POST', path: '/simulation/event', description: 'Trigger simulated match event on upstream mock' },
      ],
    };

    const acceptHeader = request.headers.accept ?? '';
    if (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html')) {
      await reply.code(200).type('application/json').send(data);
      return;
    }

    const workers = this.pollingManager.getAllWorkers();
    let closedBreakers = 0;
    let halfOpenBreakers = 0;
    let openBreakers = 0;

    for (const { worker } of workers) {
      if (worker.circuitState === CircuitState.CLOSED) closedBreakers++;
      else if (worker.circuitState === CircuitState.HALF_OPEN) halfOpenBreakers++;
      else if (worker.circuitState === CircuitState.OPEN) openBreakers++;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sports Commentary Service — Real-Time Sports Intelligence &amp; Commentary Engine</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-hover: #172136;
      --border: #1f293d;
      --border-accent: #2e3d5b;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --text-dim: #6b7280;
      --cyan: #06b6d4;
      --cyan-glow: rgba(6, 182, 212, 0.2);
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.2);
      --amber: #f59e0b;
      --amber-glow: rgba(245, 158, 11, 0.2);
      --red: #ef4444;
      --red-glow: rgba(239, 68, 68, 0.2);
      --purple: #8b5cf6;
      --code-bg: #050811;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 1.5rem 1rem;
      min-height: 100vh;
    }
    .container { max-width: 1360px; margin: 0 auto; }
    
    /* Top Header */
    header {
      background: linear-gradient(180deg, #111827 0%, rgba(17, 24, 39, 0.75) 100%);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.5rem 2rem;
      margin-bottom: 1.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.25rem;
      box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.6);
    }
    .brand { display: flex; align-items: center; gap: 0.85rem; }
    .logo-badge {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      font-weight: 900;
      color: #fff;
      box-shadow: 0 0 20px var(--cyan-glow);
    }
    .brand-text h1 {
      font-size: 1.65rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(90deg, #ffffff, #93c5fd);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      line-height: 1.2;
    }
    .brand-text p {
      font-size: 0.825rem;
      color: var(--text-muted);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-weight: 600;
    }
    .header-status {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      flex-wrap: wrap;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 1rem;
      border-radius: 9999px;
      font-size: 0.825rem;
      font-weight: 700;
      background: rgba(16, 185, 129, 0.15);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.35);
      box-shadow: 0 0 14px var(--green-glow);
    }
    .pulse-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .clock-badge {
      font-family: monospace;
      font-size: 0.85rem;
      padding: 0.45rem 0.85rem;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--cyan);
    }

    /* Primary Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 1rem;
      margin-bottom: 1.75rem;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem 1.15rem;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s, transform 0.2s;
    }
    .metric-card:hover {
      border-color: var(--border-accent);
      transform: translateY(-2px);
    }
    .metric-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--cyan), transparent);
    }
    .metric-label {
      font-size: 0.725rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    .metric-value {
      font-size: 1.85rem;
      font-weight: 800;
      color: #fff;
      margin: 0.35rem 0 0.2rem 0;
      letter-spacing: -0.02em;
      font-family: monospace;
    }
    .metric-sub {
      font-size: 0.75rem;
      color: var(--text-dim);
    }

    /* Main Operational Split */
    .dashboard-layout {
      display: grid;
      grid-template-columns: 2fr 1.2fr;
      gap: 1.5rem;
      margin-bottom: 1.75rem;
    }
    @media (max-width: 1080px) {
      .dashboard-layout { grid-template-columns: 1fr; }
    }

    /* Section Panels */
    .panel {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 1.5rem;
      margin-bottom: 1.75rem;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.85rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .panel-title {
      font-size: 1.15rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.55rem;
      color: #fff;
    }
    .panel-actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    /* Live Matches Grid */
    .matches-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1rem;
    }
    .match-card {
      background: #0d1322;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      transition: all 0.2s ease;
      position: relative;
    }
    .match-card:hover {
      border-color: #3b82f6;
      background: #111a2e;
    }
    .match-card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.8rem;
    }
    .match-id-badge {
      font-family: monospace;
      color: var(--cyan);
      background: rgba(6, 182, 212, 0.12);
      padding: 0.25rem 0.55rem;
      border-radius: 0.3rem;
      font-size: 0.75rem;
      font-weight: 700;
    }
    .match-score-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.65rem 0;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    .team-box {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .team-box.away { text-align: right; }
    .team-name { font-size: 1.1rem; font-weight: 800; color: #fff; }
    .score-display {
      font-size: 2rem;
      font-weight: 900;
      font-family: monospace;
      color: var(--cyan);
      padding: 0 1rem;
      text-align: center;
      letter-spacing: 0.1em;
    }
    .match-meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .breaker-badge {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.15rem 0.45rem;
      border-radius: 0.25rem;
      font-family: monospace;
    }
    .breaker-closed { background: rgba(16, 185, 129, 0.15); color: var(--green); border: 1px solid rgba(16, 185, 129, 0.3); }
    .breaker-half { background: rgba(245, 158, 11, 0.15); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.3); }
    .breaker-open { background: rgba(239, 68, 68, 0.15); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.3); }

    /* Momentum Bar */
    .momentum-box {
      background: rgba(17, 24, 39, 0.85);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.5rem 0.65rem;
    }
    .momentum-header {
      display: flex;
      justify-content: space-between;
      font-size: 0.7rem;
      font-weight: 700;
      margin-bottom: 0.3rem;
      color: var(--text-muted);
    }
    .momentum-bar {
      display: flex;
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
      background: #1f293d;
    }
    .momentum-home {
      background: linear-gradient(90deg, #0284c7, #38bdf8);
      transition: width 0.3s ease;
    }
    .momentum-away {
      background: linear-gradient(90deg, #f59e0b, #ef4444);
      transition: width 0.3s ease;
    }
    .momentum-tag {
      font-size: 0.65rem;
      color: var(--text-dim);
      font-style: italic;
      margin-top: 0.25rem;
      display: block;
      text-align: right;
    }

    /* Summary Card (Full-Time) */
    .full-time-banner {
      background: rgba(139, 92, 246, 0.12);
      border: 1px solid rgba(139, 92, 246, 0.35);
      border-radius: 0.5rem;
      padding: 0.6rem 0.75rem;
      font-size: 0.775rem;
    }
    .full-time-title {
      font-weight: 800;
      color: #c4b5fd;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 0.3rem;
    }
    .full-time-stats {
      display: flex;
      gap: 0.85rem;
      font-size: 0.725rem;
      color: var(--text-muted);
    }

    /* Buttons */
    .match-card-actions {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
      margin-top: 0.35rem;
    }
    .btn {
      cursor: pointer;
      border: 1px solid var(--border);
      background: #1f293d;
      color: var(--text);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.4rem 0.75rem;
      border-radius: 0.4rem;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      transition: all 0.15s;
    }
    .btn:hover { background: #2d3b55; color: #fff; }
    .btn-primary { background: #0284c7; border-color: #0369a1; color: #fff; }
    .btn-primary:hover { background: #0369a1; }
    .btn-success { background: #059669; border-color: #047857; color: #fff; }
    .btn-success:hover { background: #047857; }
    .btn-amber { background: #d97706; border-color: #b45309; color: #fff; }
    .btn-amber:hover { background: #b45309; }
    .btn-danger { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.3); color: #fff; }
    .btn-xs { padding: 0.25rem 0.5rem; font-size: 0.7rem; }
    .btn-active {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
    }

    /* Feed Controls (Filters & Styles) */
    .feed-controls {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .feed-filter-tabs {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .filter-tab {
      cursor: pointer;
      background: #111a2e;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.35rem 0.7rem;
      border-radius: 0.35rem;
      font-size: 0.75rem;
      font-weight: 600;
      transition: all 0.15s;
    }
    .filter-tab:hover { color: #fff; border-color: var(--border-accent); }
    .filter-tab.active {
      background: rgba(6, 182, 212, 0.15);
      border-color: var(--cyan);
      color: var(--cyan);
    }
    .feed-options-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .select-input {
      background: #0d1322;
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 0.75rem;
      padding: 0.35rem 0.6rem;
      border-radius: 0.35rem;
      outline: none;
    }

    /* Real-Time Event Timeline */
    .timeline-container {
      max-height: 520px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding-right: 0.35rem;
    }
    .event-card {
      background: #0d1322;
      border: 1px solid var(--border);
      border-left: 4px solid var(--cyan);
      border-radius: 0.5rem;
      padding: 0.85rem 1rem;
      display: flex;
      gap: 0.85rem;
      align-items: flex-start;
      transition: all 0.2s;
      animation: slideIn 0.3s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .event-card.flash {
      box-shadow: 0 0 16px rgba(6, 182, 212, 0.4);
      border-color: var(--cyan);
    }
    .event-card.sev-CRITICAL {
      border-left-color: var(--red);
    }
    .event-card.sev-HIGH {
      border-left-color: var(--amber);
    }
    .event-card.sev-MEDIUM {
      border-left-color: #eab308;
    }
    .event-card.sev-LOW {
      border-left-color: #3b82f6;
    }

    .event-icon {
      font-size: 1.35rem;
      line-height: 1;
      padding-top: 0.15rem;
    }
    .event-details { flex: 1; }
    .event-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.25rem;
      gap: 0.5rem;
    }
    .event-badges {
      display: flex;
      gap: 0.35rem;
      align-items: center;
    }
    .event-badge {
      font-size: 0.65rem;
      font-weight: 800;
      padding: 0.15rem 0.45rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-critical { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-high { background: rgba(245, 158, 11, 0.2); color: #fde68a; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-medium { background: rgba(234, 179, 8, 0.2); color: #fef08a; border: 1px solid rgba(234, 179, 8, 0.4); }
    .badge-low { background: rgba(59, 130, 246, 0.2); color: #bfdbfe; border: 1px solid rgba(59, 130, 246, 0.4); }

    .event-time { font-family: monospace; font-size: 0.725rem; color: var(--text-dim); }
    .event-commentary {
      font-size: 0.875rem;
      color: #fff;
      font-weight: 500;
      line-height: 1.35;
      margin: 0.25rem 0 0.35rem 0;
    }
    .event-meta-footer {
      display: flex;
      justify-content: space-between;
      font-size: 0.7rem;
      color: var(--text-muted);
    }

    /* Forms */
    .form-group {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.75rem;
    }
    .text-input {
      background: #0d1322;
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      padding: 0.55rem 0.85rem;
      color: var(--text);
      font-size: 0.85rem;
      outline: none;
      flex: 1;
      font-family: inherit;
    }
    .text-input:focus { border-color: var(--cyan); }

    /* Observability Tables */
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    th { text-align: left; padding: 0.65rem 0.85rem; background: #0d1322; color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
    td { padding: 0.65rem 0.85rem; border-bottom: 1px solid var(--border); color: var(--text); }
    tr:hover td { background: #131b2e; }

    /* Meter Progress Bar */
    .progress-bar-wrap {
      background: #1f293d;
      border-radius: 9999px;
      height: 10px;
      overflow: hidden;
      margin: 0.75rem 0;
      position: relative;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #06b6d4, #10b981);
      transition: width 0.3s ease;
    }

    /* Notifications */
    #notification {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      background: #111827;
      border: 1px solid var(--cyan);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.7);
      border-radius: 0.5rem;
      padding: 0.85rem 1.25rem;
      font-size: 0.85rem;
      color: #fff;
      display: none;
      align-items: center;
      gap: 0.5rem;
      z-index: 100;
    }
  </style>
</head>
<body>
  <div class="container">
    
    <!-- Top Operations Header -->
    <header>
      <div class="brand">
        <div class="logo-badge">⚡</div>
        <div class="brand-text">
          <h1>SPORTS COMMENTARY SERVICE</h1>
          <p>Real-Time Sports Intelligence &amp; Commentary Engine</p>
        </div>
      </div>
      <div class="header-status">
        <div class="status-badge">
          <span class="pulse-dot"></span>
          <span>● LIVE</span>
        </div>
        <div class="clock-badge" id="current-clock">--:--:-- UTC</div>
        <div id="sse-indicator" class="status-badge" style="background: rgba(6, 182, 212, 0.15); color: var(--cyan); border-color: rgba(6, 182, 212, 0.3); display: none;">
          <span>📡 SSE CONNECTED</span>
        </div>
      </div>
    </header>

    <!-- Overview Metrics Cards -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Matches Watched</div>
        <div class="metric-value" id="m-watched">${workerCount}</div>
        <div class="metric-sub">Dedicated polling workers</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Active Workers</div>
        <div class="metric-value" id="m-workers">${workerCount}</div>
        <div class="metric-sub">1:1 match concurrency</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">SSE Clients</div>
        <div class="metric-value" id="m-sse">${clientCount}</div>
        <div class="metric-sub">Real-time subscribers</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Events Detected</div>
        <div class="metric-value" id="m-events">${eventCounters.total}</div>
        <div class="metric-sub">Goals, cards &amp; subs</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">API Requests</div>
        <div class="metric-value" id="m-polls">${pollingCounters.totalPolls}</div>
        <div class="metric-sub">Upstream polls executed</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Rate Limit Usage</div>
        <div class="metric-value" id="m-ratelimit">${consumedTokens} / ${capacity}</div>
        <div class="metric-sub">Sliding window budget (${this.config.rateLimitWindowSeconds}s)</div>
      </div>
    </div>

    <!-- Main Split Layout: Live Matches on Left, Real-Time Commentary Feed on Right -->
    <div class="dashboard-layout">
      
      <!-- LEFT COLUMN: Live Match Center & Controls -->
      <div>
        
        <!-- Live Match Center Grid -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <span>🏟️ Live Match Center</span>
            </div>
            <div class="panel-actions">
              <button class="btn btn-xs btn-primary" onclick="refreshDashboard()">🔄 Refresh</button>
            </div>
          </div>
          
          <div id="matches-container" class="matches-grid">
            <div style="color: var(--text-dim); font-size: 0.85rem; padding: 1.5rem 0; text-align: center;">Loading watched matches...</div>
          </div>
        </div>

        <!-- Watchlist Management Panel -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <span>➕ Watchlist Management</span>
            </div>
          </div>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Add a match ID to spawn an isolated polling worker with dedicated circuit breaker and rate-limited upstream queries.
          </p>
          <div class="form-group">
            <input type="text" id="add-match-input" class="text-input" placeholder="e.g. match-123, match-456, match-789" />
            <button class="btn btn-primary" onclick="submitWatchMatch()">Watch Match</button>
          </div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;">
            <span style="font-size: 0.75rem; color: var(--text-dim);">Quick add demo fixtures:</span>
            <button class="btn btn-xs" onclick="quickAdd('match-123')">Arsenal vs Chelsea (match-123)</button>
            <button class="btn btn-xs" onclick="quickAdd('match-456')">Liverpool vs Everton (match-456)</button>
            <button class="btn btn-xs" onclick="quickAdd('match-789')">Real Madrid vs Barcelona (match-789)</button>
          </div>
        </div>

        <!-- Live Match Simulator (Pipeline Verification) -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <span>🎮 Mock Live Match Simulator</span>
            </div>
            <span style="font-size: 0.75rem; color: var(--cyan); font-weight: 600;">Full Engine Verification</span>
          </div>
          <p style="font-size: 0.785rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 1rem;">
            In accordance with architectural principles, simulator buttons inject changes into the <strong>Upstream Mock Provider</strong>.
            The dedicated <strong>Polling Worker</strong> polls it within the <strong>Rate Limiter</strong> budget, diffs the <strong>Snapshot</strong> via <strong>ChangeDetector</strong>, passes the incident to <strong>CommentaryEngine</strong>, and broadcasts via <strong>EventBroadcaster</strong> over <strong>SSE</strong>.
          </p>

          <div style="background: #0d1322; border: 1px solid var(--border); border-radius: 0.6rem; padding: 1rem; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
              <span style="font-size: 0.85rem; font-weight: 700; color: #fff;">Target Match:</span>
              <select id="sim-match-target" class="select-input" style="min-width: 180px;">
                <option value="match-123">Arsenal vs Chelsea (match-123)</option>
                <option value="match-456">Liverpool vs Everton (match-456)</option>
                <option value="match-789">Real Madrid vs Barcelona (match-789)</option>
              </select>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem;">
              <button class="btn btn-success" onclick="simIncident('goal', 'home')">⚽ Goal Home</button>
              <button class="btn btn-success" onclick="simIncident('goal', 'away')">⚽ Goal Away</button>
              <button class="btn btn-amber" onclick="simIncident('card', 'home', 'yellow')">🟨 Yellow Home</button>
              <button class="btn btn-amber" onclick="simIncident('card', 'away', 'yellow')">🟨 Yellow Away</button>
              <button class="btn btn-danger" onclick="simIncident('card', 'home', 'red')">🟥 Red Home</button>
              <button class="btn btn-danger" onclick="simIncident('card', 'away', 'red')">🟥 Red Away</button>
              <button class="btn" onclick="simIncident('substitution', 'home')">🔄 Sub Home</button>
              <button class="btn" onclick="simIncident('substitution', 'away')">🔄 Sub Away</button>
              <button class="btn" style="background: #7c3aed; color: #fff; border-color: #6d28d9;" onclick="simStatus('FINISHED')">🏁 Full Time</button>
              <button class="btn" style="background: #2563eb; color: #fff; border-color: #1d4ed8;" onclick="simStatus('IN_PLAY')">▶️ In Play</button>
            </div>
          </div>
        </div>

      </div>

      <!-- RIGHT COLUMN: Real-Time Commentary Feed & Observability -->
      <div>

        <!-- Live Commentary Feed Panel -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <span>🎙️ Live Commentary Feed</span>
            </div>
            <div class="panel-actions">
              <button class="btn btn-xs" onclick="clearEventFeed()">Clear Feed</button>
            </div>
          </div>

          <!-- Feed Controls: Filtering & Commentary Styles -->
          <div class="feed-controls">
            <!-- Event Filtering Tabs -->
            <div class="feed-filter-tabs">
              <div class="filter-tab active" data-filter="all" onclick="setEventFilter('all')">All Events</div>
              <div class="filter-tab" data-filter="goal" onclick="setEventFilter('goal')">⚽ Goals</div>
              <div class="filter-tab" data-filter="yellow" onclick="setEventFilter('yellow')">🟨 Yellows</div>
              <div class="filter-tab" data-filter="red" onclick="setEventFilter('red')">🟥 Reds</div>
              <div class="filter-tab" data-filter="substitution" onclick="setEventFilter('substitution')">🔄 Subs</div>
            </div>

            <!-- Options Row: Commentary Style & Match Filter -->
            <div class="feed-options-row">
              <div style="display: flex; align-items: center; gap: 0.4rem;">
                <span>Style:</span>
                <select id="commentary-style-select" class="select-input" onchange="changeCommentaryStyle(this.value)">
                  <option value="standard">Standard Narrative</option>
                  <option value="concise">Concise Tick</option>
                  <option value="professional">Professional Broadcast</option>
                </select>
              </div>

              <div style="display: flex; align-items: center; gap: 0.4rem;">
                <span>Match:</span>
                <select id="feed-match-filter" class="select-input" onchange="filterFeedByMatch(this.value)">
                  <option value="all">All Watched Matches</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Live Incident Timeline -->
          <div id="events-timeline" class="timeline-container">
            <div style="color: var(--text-dim); font-size: 0.8rem; text-align: center; padding: 2.5rem 0;">
              Connecting to Server-Sent Events stream...<br>
              <span style="font-size: 0.725rem; color: var(--text-dim); margin-top: 0.5rem; display: block;">
                Detected goals, disciplinary cards, and substitutions will stream here automatically.
              </span>
            </div>
          </div>
        </div>

        <!-- Observability & Resilience Monitor -->
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <span>📊 Observability &amp; Resilience</span>
            </div>
          </div>

          <!-- Rate Limiter Gauge -->
          <div style="margin-bottom: 1.25rem;">
            <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 700;">
              <span>Global Rate Limiter Usage</span>
              <span id="rate-percent-label" style="color: var(--cyan);">0%</span>
            </div>
            <div class="progress-bar-wrap">
              <div id="rate-progress-fill" class="progress-bar-fill" style="width: 0%;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.725rem; color: var(--text-dim);">
              <span>Consumed: <strong id="rate-consumed" style="color: #fff;">0</strong> / <span id="rate-cap-display">${capacity}</span></span>
              <span>Tokens available: <strong id="rate-available" style="color: var(--green);">${availableTokens}</strong></span>
              <span>Wait Queue: <strong id="rate-queue" style="color: #fff;">0</strong></span>
            </div>
          </div>

          <!-- Circuit Breakers Summary -->
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; text-align: center; margin-bottom: 1.25rem;">
            <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 0.5rem; padding: 0.6rem;">
              <div style="font-size: 0.675rem; color: var(--green); font-weight: 700;">CLOSED</div>
              <div id="cb-closed" style="font-size: 1.35rem; font-weight: 800; color: #fff;">${closedBreakers}</div>
            </div>
            <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 0.5rem; padding: 0.6rem;">
              <div style="font-size: 0.675rem; color: var(--amber); font-weight: 700;">HALF-OPEN</div>
              <div id="cb-half" style="font-size: 1.35rem; font-weight: 800; color: #fff;">${halfOpenBreakers}</div>
            </div>
            <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 0.5rem; padding: 0.6rem;">
              <div style="font-size: 0.675rem; color: var(--red); font-weight: 700;">OPEN</div>
              <div id="cb-open" style="font-size: 1.35rem; font-weight: 800; color: #fff;">${openBreakers}</div>
            </div>
          </div>

          <!-- Detailed Polling Statistics -->
          <table>
            <tbody>
              <tr><td>Successful Polls</td><td style="text-align: right; font-weight: 700; color: var(--green);" id="t-success-polls">${pollingCounters.successfulPolls}</td></tr>
              <tr><td>Failed Upstream Polls</td><td style="text-align: right; font-weight: 700; color: var(--red);" id="t-failed-polls">${pollingCounters.failedPolls}</td></tr>
              <tr><td>Circuit Breaker Fast-Rejections</td><td style="text-align: right; font-weight: 700; color: var(--amber);" id="t-circuit-rejects">${pollingCounters.circuitBreakerRejections}</td></tr>
              <tr><td>Goal Events Detected</td><td style="text-align: right; font-weight: 700;" id="t-goals">${eventCounters.goals}</td></tr>
              <tr><td>Yellow Cards Detected</td><td style="text-align: right; font-weight: 700;" id="t-yellows">${eventCounters.yellowCards}</td></tr>
              <tr><td>Red Cards Detected</td><td style="text-align: right; font-weight: 700;" id="t-reds">${eventCounters.redCards}</td></tr>
              <tr><td>Substitutions Detected</td><td style="text-align: right; font-weight: 700;" id="t-subs">${eventCounters.substitutions}</td></tr>
            </tbody>
          </table>
        </div>

      </div>

    </div>

    <!-- Active Worker Registry Table -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">
          <span>📋 Active Worker Registry</span>
        </div>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Match ID</th>
              <th>Teams</th>
              <th>Score</th>
              <th>Status</th>
              <th>Poll Count</th>
              <th>Last Poll</th>
              <th>Circuit State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="worker-table-body">
            <tr><td colspan="8" style="color: var(--text-dim); text-align: center;">Loading worker registry...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- API Reference Panel -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">
          <span>📚 Service API Reference</span>
        </div>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Description</th>
              <th>Sample Request</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="btn btn-xs" style="background:#0284c7; color:#fff;">GET</span></td>
              <td><code>/</code></td>
              <td>Sports Commentary Service Live Match Center &amp; Console</td>
              <td><code>curl http://localhost:3000/</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#0284c7; color:#fff;">GET</span></td>
              <td><code>/health</code></td>
              <td>Healthcheck, liveness probe &amp; subscriber counters</td>
              <td><code>curl http://localhost:3000/health</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#0284c7; color:#fff;">GET</span></td>
              <td><code>/stats</code></td>
              <td>Comprehensive operational telemetry, rate limiter, circuit breaker &amp; commentary metrics</td>
              <td><code>curl http://localhost:3000/stats</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#0284c7; color:#fff;">GET</span></td>
              <td><code>/events</code></td>
              <td>Server-Sent Events (SSE) live feed (supports ?matchId=...&amp;format=commentary&amp;style=...)</td>
              <td><code>curl -N http://localhost:3000/events</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#0284c7; color:#fff;">GET</span></td>
              <td><code>/watch/matches</code></td>
              <td>List active match IDs in the polling watchlist</td>
              <td><code>curl http://localhost:3000/watch/matches</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#059669; color:#fff;">POST</span></td>
              <td><code>/watch/matches</code></td>
              <td>Add matches to monitoring watchlist (JSON: {"matchIds": [...]})</td>
              <td><code>curl -X POST http://localhost:3000/watch/matches -H "Content-Type: application/json" -d '{"matchIds":["match-123"]}'</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#dc2626; color:#fff;">DELETE</span></td>
              <td><code>/watch/matches</code></td>
              <td>Remove matches from monitoring watchlist (JSON: {"matchIds": [...]})</td>
              <td><code>curl -X DELETE http://localhost:3000/watch/matches -H "Content-Type: application/json" -d '{"matchIds":["match-123"]}'</code></td>
            </tr>
            <tr>
              <td><span class="btn btn-xs" style="background:#059669; color:#fff;">POST</span></td>
              <td><code>/simulation/event</code></td>
              <td>Trigger simulated event on upstream mock provider</td>
              <td><code>curl -X POST http://localhost:3000/simulation/event -H "Content-Type: application/json" -d '{"matchId":"match-123","type":"goal"}'</code></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <div id="notification"></div>

  <script>
    // State
    let currentFilter = 'all';
    let currentStyle = 'standard';
    let selectedMatchFilter = 'all';
    let allReceivedEvents = [];
    let eventSource = null;

    function escapeHtml(str) {
      if (typeof str !== 'string') return String(str ?? '');
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Live Clock
    function updateClock() {
      const now = new Date();
      document.getElementById('current-clock').textContent = now.toTimeString().split(' ')[0] + ' UTC';
    }
    setInterval(updateClock, 1000);
    updateClock();

    function showNotification(msg, isError = false) {
      const el = document.getElementById('notification');
      el.textContent = (isError ? '⚠️ ' : '✅ ') + msg;
      el.style.display = 'flex';
      el.style.borderColor = isError ? 'var(--red)' : 'var(--cyan)';
      setTimeout(() => { el.style.display = 'none'; }, 3500);
    }

    // SSE Connection with format=commentary
    function connectSse() {
      if (eventSource) eventSource.close();

      const url = '/events?format=commentary' + (currentStyle ? '&style=' + encodeURIComponent(currentStyle) : '');
      eventSource = new EventSource(url);

      eventSource.onopen = () => {
        const ind = document.getElementById('sse-indicator');
        ind.style.display = 'inline-flex';
        ind.innerHTML = '<span>📡 SSE CONNECTED</span>';
        ind.style.color = 'var(--cyan)';
      };

      eventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleIncomingEvent(event);
        } catch (err) {
          // heartbeat or comment
        }
      };

      eventSource.onerror = () => {
        const ind = document.getElementById('sse-indicator');
        ind.innerHTML = '<span>📡 SSE RECONNECTING...</span>';
        ind.style.color = 'var(--amber)';
      };
    }

    function handleIncomingEvent(event) {
      allReceivedEvents.unshift(event);
      if (allReceivedEvents.length > 100) allReceivedEvents.pop();

      renderEventFeed();
      refreshDashboard();
    }

    function setEventFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.filter-tab').forEach(tab => {
        if (tab.getAttribute('data-filter') === filter) tab.classList.add('active');
        else tab.classList.remove('active');
      });
      renderEventFeed();
    }

    function changeCommentaryStyle(style) {
      currentStyle = style;
      connectSse();
      showNotification('Commentary style switched to ' + style);
    }

    function filterFeedByMatch(matchId) {
      selectedMatchFilter = matchId;
      renderEventFeed();
    }

    function clearEventFeed() {
      allReceivedEvents = [];
      renderEventFeed();
      showNotification('Event feed cleared');
    }

    function renderEventFeed() {
      const container = document.getElementById('events-timeline');
      let filtered = allReceivedEvents;

      if (selectedMatchFilter !== 'all') {
        filtered = filtered.filter(e => e.matchId === selectedMatchFilter);
      }

      if (currentFilter === 'goal') {
        filtered = filtered.filter(e => (e.type || '').toUpperCase() === 'GOAL');
      } else if (currentFilter === 'yellow') {
        filtered = filtered.filter(e => (e.type || '').toUpperCase() === 'YELLOW_CARD' || (e.cardType === 'yellow'));
      } else if (currentFilter === 'red') {
        filtered = filtered.filter(e => (e.type || '').toUpperCase() === 'RED_CARD' || (e.cardType === 'red'));
      } else if (currentFilter === 'substitution') {
        filtered = filtered.filter(e => (e.type || '').toUpperCase() === 'SUBSTITUTION');
      }

      if (filtered.length === 0) {
        container.innerHTML = '<div style="color: var(--text-dim); font-size: 0.8rem; text-align: center; padding: 2.5rem 0;">No events match the selected filters. Awaiting live match events...</div>';
        return;
      }

      container.innerHTML = filtered.map(ev => {
        const typeUpper = (ev.type || '').toUpperCase();
        let icon = '⚽';
        let badgeClass = 'badge-critical';
        let sev = ev.severity || 'CRITICAL';

        if (typeUpper === 'CARD' || typeUpper === 'YELLOW_CARD' || typeUpper === 'RED_CARD') {
          if (typeUpper === 'RED_CARD' || ev.cardType === 'red' || ev.severity === 'HIGH') {
            icon = '🟥';
            badgeClass = 'badge-high';
            sev = 'HIGH';
          } else {
            icon = '🟨';
            badgeClass = 'badge-medium';
            sev = 'MEDIUM';
          }
        } else if (typeUpper === 'SUBSTITUTION') {
          icon = '🔄';
          badgeClass = 'badge-low';
          sev = 'LOW';
        }

        const timeStr = ev.timestamp ? new Date(ev.timestamp).toTimeString().split(' ')[0] : new Date().toTimeString().split(' ')[0];
        const minuteStr = ev.minute ? ev.minute + "'" : '';
        const commentary = ev.commentary || (typeUpper + ' recorded in minute ' + (ev.minute || ''));

        return \`
          <div class="event-card sev-\${escapeHtml(sev)}">
            <span class="event-icon">\${icon}</span>
            <div class="event-details">
              <div class="event-header-row">
                <div class="event-badges">
                  <span class="event-badge \${badgeClass}">\${escapeHtml(sev)}</span>
                  <span style="font-weight: 700; color: #fff; font-size: 0.8rem;">\${escapeHtml(typeUpper)}</span>
                </div>
                <span class="event-time">\${timeStr}</span>
              </div>
              <div class="event-commentary">\${escapeHtml(commentary)}</div>
              <div class="event-meta-footer">
                <span>Match: <strong style="color: var(--cyan);">\${escapeHtml(ev.matchId)}</strong></span>
                <span>\${minuteStr ? 'Minute ' + minuteStr : ''}</span>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    // Refresh Dashboard Telemetry via /stats
    async function refreshDashboard() {
      try {
        const res = await fetch('/stats');
        if (!res.ok) return;
        const data = await res.json();
        updateDashboardView(data);
      } catch (err) {
        // silent retry
      }
    }

    function updateDashboardView(data) {
      // Top Metrics
      document.getElementById('m-watched').textContent = data.watchlist.total;
      document.getElementById('m-workers').textContent = data.watchlist.total;
      document.getElementById('m-sse').textContent = data.sse.connectedClients;
      document.getElementById('m-events').textContent = data.metrics.events.total;
      document.getElementById('m-polls').textContent = data.metrics.polling.totalPolls;
      document.getElementById('m-ratelimit').textContent = data.rateLimiter.consumedTokens + ' / ' + data.rateLimiter.capacity;

      // Rate Limiter Meter
      const ratePercent = Math.min(100, data.rateLimiter.usagePercent);
      document.getElementById('rate-percent-label').textContent = ratePercent + '%';
      document.getElementById('rate-progress-fill').style.width = ratePercent + '%';
      document.getElementById('rate-consumed').textContent = data.rateLimiter.consumedTokens;
      document.getElementById('rate-available').textContent = data.rateLimiter.availableTokens;
      document.getElementById('rate-queue').textContent = data.rateLimiter.queueLength;

      // Circuit Breakers
      document.getElementById('cb-closed').textContent = data.circuitBreakers.summary.closed;
      document.getElementById('cb-half').textContent = data.circuitBreakers.summary.halfOpen;
      document.getElementById('cb-open').textContent = data.circuitBreakers.summary.open;

      // Polling Table
      document.getElementById('t-success-polls').textContent = data.metrics.polling.successfulPolls;
      document.getElementById('t-failed-polls').textContent = data.metrics.polling.failedPolls;
      document.getElementById('t-circuit-rejects').textContent = data.metrics.polling.circuitBreakerRejections;
      document.getElementById('t-goals').textContent = data.metrics.events.goals;
      document.getElementById('t-yellows').textContent = data.metrics.events.yellowCards;
      document.getElementById('t-reds').textContent = data.metrics.events.redCards;
      document.getElementById('t-subs').textContent = data.metrics.events.substitutions;

      // Render Matches Grid & Worker Registry Table
      renderMatchesGrid(data.watchlist.matches);
      renderWorkerTable(data.watchlist.matches);
      updateMatchDropdowns(data.watchlist.matches);
    }

    function updateMatchDropdowns(matches) {
      const feedSelect = document.getElementById('feed-match-filter');
      const simSelect = document.getElementById('sim-match-target');

      const currentFeedVal = feedSelect.value;
      const currentSimVal = simSelect.value;

      feedSelect.innerHTML = '<option value="all">All Watched Matches</option>' +
        matches.map(m => \`<option value="\${escapeHtml(m.matchId)}">\${escapeHtml(m.matchId)}</option>\`).join('');
      feedSelect.value = currentFeedVal;

      if (matches.length > 0) {
        simSelect.innerHTML = matches.map(m => {
          const name = m.snapshot ? m.snapshot.homeTeam + ' vs ' + m.snapshot.awayTeam : m.matchId;
          return \`<option value="\${escapeHtml(m.matchId)}">\${escapeHtml(name)} (\${escapeHtml(m.matchId)})</option>\`;
        }).join('');
        if (matches.some(m => m.matchId === currentSimVal)) {
          simSelect.value = currentSimVal;
        }
      }
    }

    function renderMatchesGrid(matches) {
      const container = document.getElementById('matches-container');
      if (!matches || matches.length === 0) {
        container.innerHTML = '<div style="color: var(--text-dim); font-size: 0.85rem; padding: 2rem 0; text-align: center;">No matches currently in watchlist. Use the form above to add matches.</div>';
        return;
      }

      container.innerHTML = matches.map(m => {
        const snap = m.snapshot;
        const home = snap ? snap.homeTeam : 'Home Team';
        const away = snap ? snap.awayTeam : 'Away Team';
        const score = snap ? snap.score.home + ' - ' + snap.score.away : '0 - 0';
        const minute = snap && snap.minute ? snap.minute + "'" : 'LIVE';
        const status = snap ? snap.status : 'POLLING';

        let breakerClass = 'breaker-closed';
        if (m.circuitState === 'HALF_OPEN') breakerClass = 'breaker-half';
        if (m.circuitState === 'OPEN') breakerClass = 'breaker-open';

        const lastPollAgo = m.lastPollAt ? Math.round((Date.now() - m.lastPollAt)/1000) + 's ago' : 'Pending';

        // Momentum Bar
        const momentum = m.momentum;
        const homePct = momentum ? momentum.homePercent : 50;
        const awayPct = momentum ? momentum.awayPercent : 50;

        // Full-Time Summary
        const summary = m.summary;

        return \`
          <div class="match-card">
            <div class="match-card-top">
              <span class="match-id-badge">\${escapeHtml(m.matchId)}</span>
              <span style="font-weight: 700; color: var(--cyan);">\${minute} • \${escapeHtml(status)}</span>
            </div>
            
            <div class="match-score-row">
              <div class="team-box"><span class="team-name">\${escapeHtml(home)}</span></div>
              <div class="score-display">\${score}</div>
              <div class="team-box away"><span class="team-name">\${escapeHtml(away)}</span></div>
            </div>

            <div class="match-meta-row">
              <span>Circuit: <strong class="breaker-badge \${breakerClass}">\${m.circuitState}</strong></span>
              <span>Last poll: \${lastPollAgo}</span>
            </div>

            <!-- Momentum Indicator -->
            <div class="momentum-box">
              <div class="momentum-header">
                <span>\${escapeHtml(home)} \${homePct}%</span>
                <span>\${escapeHtml(away)} \${awayPct}%</span>
              </div>
              <div class="momentum-bar">
                <div class="momentum-home" style="width: \${homePct}%;"></div>
                <div class="momentum-away" style="width: \${awayPct}%;"></div>
              </div>
              <span class="momentum-tag">Engine-generated momentum</span>
            </div>

            <!-- Full-Time Summary Banner (if ended) -->
            \${summary ? \`
              <div class="full-time-banner">
                <div class="full-time-title">🏁 \${escapeHtml(summary.headline)}</div>
                <div class="full-time-stats">
                  <span>⚽ Goals: \${summary.goals.length}</span>
                  <span>🟨 Cards: \${summary.totalCards}</span>
                  <span>🔄 Subs: \${summary.totalSubstitutions}</span>
                </div>
              </div>
            \` : ''}

            <!-- Match Actions -->
            <div class="match-card-actions">
              <button class="btn btn-xs" onclick="triggerMatchGoal('\${escapeHtml(m.matchId)}', '\${escapeHtml(home)}')">⚽ +Home Goal</button>
              <button class="btn btn-xs" onclick="triggerMatchGoal('\${escapeHtml(m.matchId)}', '\${escapeHtml(away)}')">⚽ +Away Goal</button>
              <button class="btn btn-xs btn-danger" onclick="removeMatch('\${escapeHtml(m.matchId)}')">✕ Unwatch</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderWorkerTable(matches) {
      const tbody = document.getElementById('worker-table-body');
      if (!matches || matches.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="color: var(--text-dim); text-align: center;">No workers active.</td></tr>';
        return;
      }

      tbody.innerHTML = matches.map(m => {
        const snap = m.snapshot;
        const teams = snap ? snap.homeTeam + ' vs ' + snap.awayTeam : '—';
        const score = snap ? snap.score.home + ' - ' + snap.score.away : '—';
        const status = snap ? snap.status : (m.workerRunning ? 'RUNNING' : 'STOPPED');
        const lastPollAgo = m.lastPollAt ? Math.round((Date.now() - m.lastPollAt)/1000) + 's ago' : 'Never';

        let breakerColor = 'var(--green)';
        if (m.circuitState === 'HALF_OPEN') breakerColor = 'var(--amber)';
        if (m.circuitState === 'OPEN') breakerColor = 'var(--red)';

        return \`
          <tr>
            <td><code style="color: var(--cyan); font-weight: 700;">\${escapeHtml(m.matchId)}</code></td>
            <td><strong>\${escapeHtml(teams)}</strong></td>
            <td style="font-family: monospace; font-weight: 800;">\${score}</td>
            <td><span class="btn btn-xs" style="background:#1e293b; color:#94a3b8;">\${escapeHtml(status)}</span></td>
            <td>\${m.pollCount}</td>
            <td>\${lastPollAgo}</td>
            <td><strong style="color: \${breakerColor};">\${m.circuitState}</strong></td>
            <td>
              <button class="btn btn-xs btn-danger" onclick="removeMatch('\${escapeHtml(m.matchId)}')">Stop &amp; Remove</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    // Watchlist API actions
    async function submitWatchMatch() {
      const input = document.getElementById('add-match-input');
      const val = input.value.trim();
      if (!val) return;

      const matchIds = val.split(',').map(s => s.trim()).filter(Boolean);
      try {
        const res = await fetch('/watch/matches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchIds }),
        });
        if (res.ok) {
          showNotification('Watchlist updated for ' + matchIds.join(', '));
          input.value = '';
          refreshDashboard();
        } else {
          showNotification('Failed to add matches', true);
        }
      } catch (err) {
        showNotification('Network error adding matches', true);
      }
    }

    async function quickAdd(matchId) {
      document.getElementById('add-match-input').value = matchId;
      await submitWatchMatch();
    }

    async function removeMatch(matchId) {
      try {
        const res = await fetch('/watch/matches', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchIds: [matchId] }),
        });
        if (res.ok) {
          showNotification('Removed ' + matchId + ' from watchlist');
          refreshDashboard();
        } else {
          showNotification('Failed to remove ' + matchId, true);
        }
      } catch (err) {
        showNotification('Network error removing match', true);
      }
    }

    // Simulator API actions (modifying upstream mock provider)
    async function simIncident(type, side, cardType) {
      const matchId = document.getElementById('sim-match-target').value;
      const res = await fetch('/simulation/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId,
          type,
          cardType,
        }),
      });

      if (res.ok) {
        showNotification('Simulated ' + type + ' for ' + matchId + '. Polling worker will detect it.');
      } else {
        showNotification('Simulation request failed', true);
      }
    }

    async function simStatus(status) {
      const matchId = document.getElementById('sim-match-target').value;
      const res = await fetch('/simulation/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, status }),
      });

      if (res.ok) {
        showNotification('Match status updated to ' + status + ' on upstream mock.');
      } else {
        showNotification('Simulation status update failed', true);
      }
    }

    async function triggerMatchGoal(matchId, team) {
      const res = await fetch('/simulation/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, type: 'goal', team }),
      });
      if (res.ok) {
        showNotification('Injected goal for ' + team + ' into ' + matchId);
      }
    }

    // Init
    connectSse();
    refreshDashboard();
    setInterval(refreshDashboard, 5000);
  </script>
</body>
</html>`;

    await reply.code(200).type('text/html; charset=utf-8').send(html);
  };
}
