import { z } from 'zod';

/**
 * A match identifier: non-empty, trimmed, and restricted to characters that are
 * safe to interpolate into an upstream URL path.
 */
export const MatchIdSchema = z
  .string({ invalid_type_error: 'matchIds must be an array of strings' })
  .trim()
  .min(1, 'matchId must not be empty')
  .max(128, 'matchId must be at most 128 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'matchId may only contain letters, digits, ".", "_", ":" and "-"');

/** Body accepted by `POST /watch/matches` and `DELETE /watch/matches`. */
export const WatchMatchesRequestSchema = z.object({
  matchIds: z
    .array(MatchIdSchema, { required_error: 'matchIds is required' })
    .min(1, 'matchIds must contain at least one match id')
    .max(500, 'matchIds must contain at most 500 match ids'),
});

export type WatchMatchesRequest = z.infer<typeof WatchMatchesRequestSchema>;

/** Body returned by `GET /watch/matches`. */
export interface WatchListResponse {
  watching: string[];
}

/** Body returned by `POST /watch/matches` (202 Accepted). */
export interface WatchAcceptedResponse {
  accepted: string[];
  alreadyWatching: string[];
  watching: string[];
}
