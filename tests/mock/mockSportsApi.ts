import {
  MockSportsApiServer,
  createFixture,
  type MockMatchFixture,
  type MockTimelineEntry,
  type RecordedRequest,
} from '../../src/mock/MockSportsApiServer';

export {
  MockSportsApiServer,
  createFixture,
  type MockMatchFixture,
  type MockTimelineEntry,
  type RecordedRequest,
};

export const HOME_TEAM = 'Arsenal';
export const AWAY_TEAM = 'Chelsea';

/** Start a mock upstream provider on an ephemeral port. */
export async function startMockSportsApi(): Promise<MockSportsApiServer> {
  const server = new MockSportsApiServer();
  await server.start(0, '127.0.0.1');
  return server;
}

/** A goalless baseline fixture. */
export function baselineFixture(matchId: string): MockMatchFixture {
  return createFixture(matchId, {
    homeTeam: HOME_TEAM,
    awayTeam: AWAY_TEAM,
    status: 'IN_PLAY',
    minute: 5,
    score: { home: 0, away: 0 },
    events: [],
  });
}

export const goalEntry = (overrides: Partial<MockTimelineEntry> = {}): MockTimelineEntry => ({
  id: 'goal-1',
  type: 'goal',
  team: HOME_TEAM,
  player: 'Bukayo Saka',
  minute: 15,
  ...overrides,
});

export const cardEntry = (overrides: Partial<MockTimelineEntry> = {}): MockTimelineEntry => ({
  id: 'card-1',
  type: 'card',
  team: AWAY_TEAM,
  player: 'Reece James',
  minute: 22,
  cardType: 'yellow',
  ...overrides,
});

export const substitutionEntry = (
  overrides: Partial<MockTimelineEntry> = {},
): MockTimelineEntry => ({
  id: 'sub-1',
  type: 'substitution',
  team: HOME_TEAM,
  playerIn: 'Gabriel Jesus',
  playerOut: 'Kai Havertz',
  minute: 67,
  ...overrides,
});
