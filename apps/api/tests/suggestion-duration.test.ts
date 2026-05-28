/**
 * Regression test for the "SlotUnavailable suggests 1-hour slots regardless of
 * requested duration" bug.
 *
 * Before the fix, `unavailableWithSuggestions` in graphql/schema.ts hard-coded
 * a 60-minute window when calling suggestSlots. A user trying to book a 3-hour
 * session would receive suggestion chips claiming "nearest available slots",
 * click one, and still get SLOT_UNAVAILABLE — because the chips only proved
 * a 1-hour gap existed.
 *
 * This test mocks the service layer so the resolver throws SLOT_UNAVAILABLE
 * for a 180-minute request, and asserts the resolver forwards `durationMs =
 * 180 * 60_000` to `suggestSlots`.
 *
 * No DB required — pure resolver-level test against the in-memory schema.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GraphQLContext } from '../src/graphql/builder.js';

// Hoisted by vitest. These must come before the schema/services import below.
vi.mock('../src/services/sessions.js', async () => {
  const { DomainError } = await import('../src/services/errors.js');
  return {
    createSession: vi.fn(async () => {
      throw new DomainError('SLOT_UNAVAILABLE', 'arena is full', {
        arenaId: 1,
        start: new Date('2030-01-01T10:00:00Z'),
        end: new Date('2030-01-01T13:00:00Z'), // 3-hour window
        conflictingCount: 5,
      });
    }),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    checkAvailability: vi.fn(),
    getArena: vi.fn(),
    listArenas: vi.fn(),
    sessionsByArena: vi.fn(),
    sessionsByArenaBatch: vi.fn(),
  };
});

vi.mock('../src/services/slots.js', () => ({
  suggestSlots: vi.fn(async ({ durationMs }: { durationMs: number }) => {
    // Echo the requested duration back so the test can verify it round-trips.
    const start = new Date('2030-01-02T08:00:00Z');
    return [{ start, end: new Date(start.getTime() + durationMs) }];
  }),
}));

describe('SlotUnavailable suggestions honour the requested duration', () => {
  it('forwards the requested duration to suggestSlots — create path', async () => {
    const { graphql } = await import('graphql');
    const { schema } = await import('../src/graphql/schema.js');
    const { suggestSlots } = await import('../src/services/slots.js');

    const result = await graphql({
      schema,
      contextValue: { loaders: {} } as unknown as GraphQLContext,
      source: `
        mutation Create($input: CreateSessionInput!) {
          createSession(input: $input) {
            __typename
            ... on SlotUnavailable {
              suggestions { start end }
              conflictingCount
              capacity
            }
          }
        }
      `,
      variableValues: {
        input: {
          arenaId: '1',
          startTime: '2030-01-01T10:00:00Z',
          durationMinutes: 180, // 3 hours — must NOT be coerced to 60
        },
      },
    });

    expect(result.errors).toBeUndefined();
    // 1. The resolver passed the right duration into suggestSlots.
    expect(suggestSlots).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 180 * 60_000 }),
    );

    // 2. The suggestion length actually returned to the client is 180 min,
    //    not the old 60-min fallback.
    const payload = (result.data as { createSession: { __typename: string; suggestions: Array<{ start: string; end: string }> } }).createSession;
    expect(payload.__typename).toBe('SlotUnavailable');
    const slot = payload.suggestions[0]!;
    const slotMin = (new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60_000;
    expect(slotMin).toBe(180);
  });
});
