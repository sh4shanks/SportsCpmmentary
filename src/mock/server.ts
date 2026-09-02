import {
  MockSportsApiServer,
  createFixture,
  type MockTimelineEntry,
} from './MockSportsApiServer';

/**
 * Standalone runner for the mock provider (`npm run mock`, or the
 * `mock-sports-api` container in docker-compose).
 *
 * It seeds two fixtures and then simulates a live match by appending a new
 * incident every `MOCK_EVENT_INTERVAL_SECONDS`, which makes the SSE stream
 * demonstrable end to end without any third-party API key.
 */
const port = Number(process.env.MOCK_API_PORT ?? 4000);
const eventIntervalMs = Number(process.env.MOCK_EVENT_INTERVAL_SECONDS ?? 20) * 1000;

const HOME = 'Arsenal';
const AWAY = 'Chelsea';

const SCRIPT: MockTimelineEntry[] = [
  { id: 'e1', type: 'goal', team: HOME, player: 'Bukayo Saka', minute: 12 },
  { id: 'e2', type: 'card', team: AWAY, player: 'Reece James', minute: 23, cardType: 'yellow' },
  { id: 'e3', type: 'goal', team: AWAY, player: 'Cole Palmer', minute: 38 },
  {
    id: 'e4',
    type: 'substitution',
    team: HOME,
    playerIn: 'Gabriel Jesus',
    playerOut: 'Kai Havertz',
    minute: 61,
  },
  { id: 'e5', type: 'goal', team: HOME, player: 'Martin Odegaard', minute: 74 },
  { id: 'e6', type: 'card', team: HOME, player: 'Declan Rice', minute: 82, cardType: 'red' },
];

async function main(): Promise<void> {
  const server = new MockSportsApiServer();

  server.setMatch(createFixture('match-123', { homeTeam: HOME, awayTeam: AWAY }));
  server.setMatch(
    createFixture('match-456', { homeTeam: 'Liverpool', awayTeam: 'Everton', minute: 5 }),
  );

  await server.start(port);

  process.stdout.write(
    `[mock-sports-api] listening on http://0.0.0.0:${port} (GET /matches/match-123)\n`,
  );

  let index = 0;
  const timer = setInterval(() => {
    const entry = SCRIPT[index % SCRIPT.length];
    if (!entry) {
      return;
    }

    // Restart the fixture once the script has been replayed once.
    if (index > 0 && index % SCRIPT.length === 0) {
      server.setMatch(createFixture('match-123', { homeTeam: HOME, awayTeam: AWAY }));
    }

    server.addEvent('match-123', entry);
    index += 1;

    process.stdout.write(
      `[mock-sports-api] appended ${entry.type} at minute ${entry.minute} to match-123\n`,
    );
  }, eventIntervalMs);

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`[mock-sports-api] fatal: ${String(error)}\n`);
  process.exit(1);
});
