import request from 'supertest';
import {
  SseTestClient,
  createHarness,
  waitFor,
  type TestHarness,
} from '../helpers/testHarness';
import {
  AWAY_TEAM,
  HOME_TEAM,
  baselineFixture,
  cardEntry,
  goalEntry,
  substitutionEntry,
} from '../mock/mockSportsApi';
import { CommentaryEngine } from '../../src/engine/CommentaryEngine';
import { InMemoryStateManager } from '../../src/engine/StateManager';
import type { GoalEvent, CardEvent, SubstitutionEvent } from '../../src/models/MatchEvent';
import type { MatchSnapshot } from '../../src/models/MatchSnapshot';

describe('CommentaryEngine & Real-Time Commentary Pipeline', () => {
  describe('CommentaryEngine Unit Tests', () => {
    const engine = new CommentaryEngine();

    const mockGoalEvent: GoalEvent = {
      id: 'e-1',
      matchId: 'match-100',
      detectedAt: 1700000000000,
      type: 'goal',
      payload: {
        matchId: 'match-100',
        team: 'Arsenal',
        player: 'Bukayo Saka',
        minute: 67,
        score: '2-1',
      },
    };

    const mockYellowCardEvent: CardEvent = {
      id: 'e-2',
      matchId: 'match-100',
      detectedAt: 1700000000000,
      type: 'card',
      payload: {
        matchId: 'match-100',
        team: 'Chelsea',
        player: 'Reece James',
        minute: 45,
        cardType: 'yellow',
      },
    };

    const mockRedCardEvent: CardEvent = {
      id: 'e-3',
      matchId: 'match-100',
      detectedAt: 1700000000000,
      type: 'card',
      payload: {
        matchId: 'match-100',
        team: 'Chelsea',
        player: 'Enzo Fernandez',
        minute: 82,
        cardType: 'red',
      },
    };

    const mockSubEvent: SubstitutionEvent = {
      id: 'e-4',
      matchId: 'match-100',
      detectedAt: 1700000000000,
      type: 'substitution',
      payload: {
        matchId: 'match-100',
        team: 'Arsenal',
        playerIn: 'Gabriel Jesus',
        playerOut: 'Kai Havertz',
        minute: 60,
      },
    };

    it('generates standard, concise, and professional goal commentary with CRITICAL severity', () => {
      const standard = engine.generate(mockGoalEvent, undefined, 'standard');
      expect(standard.severity).toBe('CRITICAL');
      expect(standard.type).toBe('GOAL');
      expect(standard.commentary).toContain('Arsenal');
      expect(standard.commentary).toContain('Bukayo Saka');
      expect(standard.commentary).toContain('67th minute');

      const concise = engine.generate(mockGoalEvent, undefined, 'concise');
      expect(concise.commentary).toBe("67' — GOAL Arsenal. Bukayo Saka (2-1).");

      const professional = engine.generate(mockGoalEvent, undefined, 'professional');
      expect(professional.commentary).toContain('Arsenal move ahead');
      expect(professional.commentary).toContain('Bukayo Saka in minute 67 (2-1)');
    });

    it('generates yellow card commentary with MEDIUM severity across styles', () => {
      const standard = engine.generate(mockYellowCardEvent, undefined, 'standard');
      expect(standard.severity).toBe('MEDIUM');
      expect(standard.type).toBe('YELLOW_CARD');
      expect(standard.commentary).toContain('Reece James (Chelsea) receives a booking in the 45th minute');

      const concise = engine.generate(mockYellowCardEvent, undefined, 'concise');
      expect(concise.commentary).toBe("45' — YELLOW CARD Reece James (Chelsea).");

      const professional = engine.generate(mockYellowCardEvent, undefined, 'professional');
      expect(professional.commentary).toContain('shown a yellow card by the referee for a disciplinary infraction in minute 45');
    });

    it('generates red card commentary with HIGH severity across styles', () => {
      const standard = engine.generate(mockRedCardEvent, undefined, 'standard');
      expect(standard.severity).toBe('HIGH');
      expect(standard.type).toBe('RED_CARD');
      expect(standard.commentary).toContain('Enzo Fernandez (Chelsea) is sent off in the 82nd minute!');

      const concise = engine.generate(mockRedCardEvent, undefined, 'concise');
      expect(concise.commentary).toBe("82' — RED CARD Enzo Fernandez (Chelsea).");

      const professional = engine.generate(mockRedCardEvent, undefined, 'professional');
      expect(professional.commentary).toContain('reduced to 10 players as Enzo Fernandez receives a straight red card in minute 82');
    });

    it('generates substitution commentary with LOW severity across styles', () => {
      const standard = engine.generate(mockSubEvent, undefined, 'standard');
      expect(standard.severity).toBe('LOW');
      expect(standard.type).toBe('SUBSTITUTION');
      expect(standard.commentary).toContain('Gabriel Jesus to replace Kai Havertz in the 60th minute');

      const concise = engine.generate(mockSubEvent, undefined, 'concise');
      expect(concise.commentary).toBe("60' — SUB Arsenal: Gabriel Jesus on for Kai Havertz.");

      const professional = engine.generate(mockSubEvent, undefined, 'professional');
      expect(professional.commentary).toContain('tactical alteration: Gabriel Jesus enters the pitch in place of Kai Havertz (minute 60)');
    });

    it('classifies event severity extensibly including future types', () => {
      expect(engine.classifySeverity('GOAL')).toBe('CRITICAL');
      expect(engine.classifySeverity('MATCH_SUSPENDED')).toBe('CRITICAL');
      expect(engine.classifySeverity('RED_CARD')).toBe('HIGH');
      expect(engine.classifySeverity('PENALTY')).toBe('HIGH');
      expect(engine.classifySeverity('VAR')).toBe('HIGH');
      expect(engine.classifySeverity('YELLOW_CARD')).toBe('MEDIUM');
      expect(engine.classifySeverity('FULL_TIME')).toBe('MEDIUM');
      expect(engine.classifySeverity('SUBSTITUTION')).toBe('LOW');
      expect(engine.classifySeverity('CORNER')).toBe('LOW');
      expect(engine.classifySeverity('OFFSIDE')).toBe('LOW');
    });

    it('calculates engine-generated momentum based purely on actual match incidents', () => {
      const timeline = [
        {
          id: 't-1',
          matchId: 'match-100',
          minute: 12,
          type: 'goal' as const,
          team: 'Arsenal',
          description: 'Goal: Saka',
          commentary: 'GOAL!',
          severity: 'CRITICAL' as const,
          detectedAt: 1,
          icon: '⚽',
        },
        {
          id: 't-2',
          matchId: 'match-100',
          minute: 35,
          type: 'card' as const,
          team: 'Chelsea',
          description: 'Red Card: James',
          commentary: 'Red card!',
          severity: 'HIGH' as const,
          detectedAt: 2,
          icon: '🟥',
        },
      ];

      const momentum = engine.calculateMomentum(
        'Arsenal',
        'Chelsea',
        timeline,
        { home: 1, away: 0 },
      );

      expect(momentum.label).toBe('Engine-generated momentum');
      expect(momentum.homePercent).toBeGreaterThan(50);
      expect(momentum.homePercent + momentum.awayPercent).toBe(100);
      expect(momentum.explanation).toContain('Arsenal holding significant attacking momentum');
    });

    it('generates full-time summary with accurate incident tallies', () => {
      const snapshot: MatchSnapshot = {
        matchId: 'match-100',
        status: 'FINISHED',
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        score: { home: 2, away: 1 },
        minute: 90,
        events: [],
        fetchedAt: 1000,
      };

      const timeline = [
        {
          id: '1',
          matchId: 'match-100',
          minute: 23,
          type: 'goal' as const,
          team: 'Arsenal',
          description: 'Goal: Saka',
          commentary: 'GOAL',
          severity: 'CRITICAL' as const,
          detectedAt: 1,
          icon: '⚽',
        },
        {
          id: '2',
          matchId: 'match-100',
          minute: 51,
          type: 'goal' as const,
          team: 'Chelsea',
          description: 'Goal: Palmer',
          commentary: 'GOAL',
          severity: 'CRITICAL' as const,
          detectedAt: 2,
          icon: '⚽',
        },
        {
          id: '3',
          matchId: 'match-100',
          minute: 67,
          type: 'goal' as const,
          team: 'Arsenal',
          description: 'Goal: Jesus',
          commentary: 'GOAL',
          severity: 'CRITICAL' as const,
          detectedAt: 3,
          icon: '⚽',
        },
        {
          id: '4',
          matchId: 'match-100',
          minute: 78,
          type: 'card' as const,
          team: 'Chelsea',
          description: 'Yellow Card: Silva',
          commentary: 'Booking',
          severity: 'MEDIUM' as const,
          detectedAt: 4,
          icon: '🟨',
        },
      ];

      const summary = engine.generateFullTimeSummary(snapshot, timeline);
      expect(summary.headline).toContain('Arsenal claim victory over Chelsea (2-1)');
      expect(summary.goals.length).toBe(3);
      expect(summary.totalCards).toBe(1);
      expect(summary.totalYellowCards).toBe(1);
      expect(summary.totalEvents).toBe(4);
    });
  });

  describe('Timeline Management in InMemoryStateManager', () => {
    it('stores match events in chronological order and clears on delete', () => {
      const stateManager = new InMemoryStateManager();

      stateManager.recordTimelineEvent('m-1', {
        id: 't-1',
        matchId: 'm-1',
        minute: 10,
        type: 'goal',
        team: 'Arsenal',
        description: 'Goal Saka',
        commentary: 'GOAL!',
        severity: 'CRITICAL',
        detectedAt: 100,
        icon: '⚽',
      });

      stateManager.recordTimelineEvent('m-1', {
        id: 't-2',
        matchId: 'm-1',
        minute: 25,
        type: 'card',
        team: 'Chelsea',
        description: 'Yellow James',
        commentary: 'Booking',
        severity: 'MEDIUM',
        detectedAt: 200,
        icon: '🟨',
      });

      const timeline = stateManager.getTimeline('m-1');
      expect(timeline.length).toBe(2);
      expect(timeline[0].id).toBe('t-2'); // Most recent first
      expect(timeline[1].id).toBe('t-1');

      // Unrelated match has empty timeline
      expect(stateManager.getTimeline('m-2')).toEqual([]);

      // Removing match clears timeline
      stateManager.delete('m-1');
      expect(stateManager.getTimeline('m-1')).toEqual([]);
    });
  });

  describe('SSE Commentary Stream & Match Filtering', () => {
    let harness: TestHarness;
    let client1: SseTestClient | null = null;
    let client2: SseTestClient | null = null;

    beforeEach(async () => {
      harness = await createHarness({ listen: true });
      harness.mock.setMatch(baselineFixture('match-A'));
      harness.mock.setMatch(baselineFixture('match-B'));
    });

    afterEach(async () => {
      client1?.close();
      client2?.close();
      client1 = null;
      client2 = null;
      await harness.close();
    });

    it('emits structured commentary format when ?format=commentary is requested', async () => {
      client1 = await SseTestClient.connect(`${harness.baseUrl}/events?format=commentary&style=concise`);

      await request(harness.app.server).post('/watch/matches').send({ matchIds: ['match-A'] });
      await waitFor(() => harness.mock.requestCount('match-A') >= 1);

      harness.mock.addEvent('match-A', goalEntry({ team: HOME_TEAM, player: 'Bukayo Saka', minute: 15 }));

      const event = await client1.waitForEvent('goal');
      expect(event.event).toBe('goal');

      const data = event.json();
      expect(data).toMatchObject({
        matchId: 'match-A',
        type: 'GOAL',
        severity: 'CRITICAL',
        minute: 15,
        team: HOME_TEAM,
      });
      expect(data.commentary).toContain('GOAL Arsenal');
      expect(data.timestamp).toBeDefined();
    });

    it('filters SSE events by matchId when ?matchId=... is provided', async () => {
      client1 = await SseTestClient.connect(`${harness.baseUrl}/events?matchId=match-A`);
      client2 = await SseTestClient.connect(`${harness.baseUrl}/events?matchId=match-B`);

      await request(harness.app.server).post('/watch/matches').send({ matchIds: ['match-A', 'match-B'] });
      await waitFor(() => harness.mock.requestCount('match-A') >= 1 && harness.mock.requestCount('match-B') >= 1);

      // Inject event only into match-A
      harness.mock.addEvent('match-A', goalEntry({ team: HOME_TEAM, minute: 30 }));

      const eventForClient1 = await client1.waitForEvent('goal');
      expect(eventForClient1.json().matchId).toBe('match-A');

      // Client 2 should not have received any event for match-B
      expect(client2.events.length).toBe(0);
    });

    it('executes the full end-to-end pipeline via simulation', async () => {
      client1 = await SseTestClient.connect(`${harness.baseUrl}/events?format=commentary`);

      await request(harness.app.server).post('/watch/matches').send({ matchIds: ['match-A'] });
      await waitFor(() => harness.mock.requestCount('match-A') >= 1);

      // Trigger simulation via POST /simulation/event
      const simResponse = await request(harness.app.server)
        .post('/simulation/event')
        .send({
          matchId: 'match-A',
          type: 'card',
          cardType: 'red',
          player: 'Declan Rice',
          minute: 88,
        });

      expect(simResponse.status).toBe(200);
      expect(simResponse.body.status).toBe('simulated');

      // Verify that the polling worker picked it up, detected it, generated commentary, and broadcasted via SSE
      const sseEvent = await client1.waitForEvent('card');
      expect(sseEvent.event).toBe('card');
      const payload = sseEvent.json();
      expect(payload.severity).toBe('HIGH');
      expect(payload.type).toBe('CARD');
      expect(payload.commentary).toContain('RED CARD!');

      // Verify stats reflects the detected event
      const statsRes = await request(harness.app.server).get('/stats');
      expect(statsRes.status).toBe(200);
      expect(statsRes.body.metrics.events.redCards).toBeGreaterThanOrEqual(1);

      const matchStats = statsRes.body.watchlist.matches.find((m: { matchId: string }) => m.matchId === 'match-A');
      expect(matchStats).toBeDefined();
      expect(matchStats.timeline.length).toBeGreaterThanOrEqual(1);
      expect(matchStats.momentum).toBeDefined();
    });
  });
});
