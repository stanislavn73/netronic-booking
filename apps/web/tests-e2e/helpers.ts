/**
 * Test helpers — drive the GraphQL API directly for setup/teardown.
 *
 * Strategy: every test picks a UNIQUE far-future date computed from
 * its test index (passed via the `bucket` argument). Different tests
 * use different days so they can't pollute each other, and the dates
 * are far enough in the future that they won't collide with seed data.
 */
import { expect, type Page } from '@playwright/test';

export const GQL_URL = 'http://localhost:4000/graphql';

export interface TestSession {
  id: string;
  arenaId: string;
  startTime: string;
  endTime: string;
}

async function gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

/**
 * A date far enough in the future that seed data never touches it.
 * Different `bucket` values give different days — pass a unique number per test
 * so tests can't pollute each other.
 */
export function isolatedDate(bucket: number): Date {
  // 2099-01-01 + bucket days
  const base = new Date('2099-01-01T00:00:00.000Z');
  base.setUTCDate(base.getUTCDate() + bucket);
  return base;
}

/**
 * Convert a Date instant to the string format a <input type="datetime-local">
 * expects — i.e. LOCAL-time `YYYY-MM-DDTHH:MM`. Use this whenever a test needs
 * to fill a datetime-local input with the same instant it pre-booked via the
 * API, otherwise you silently get a timezone-shifted slot.
 */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function pickFirstArenaId(): Promise<string> {
  const data = await gql<{ arenas: Array<{ id: string }> }>(
    `query { arenas(limit: 1) { id } }`,
  );
  if (!data.arenas[0]) throw new Error('No arenas — did you run `make seed`?');
  return data.arenas[0].id;
}

/** Cancel any active sessions for arenaId on the given UTC day. */
export async function cleanArenaDay(arenaId: string, day: Date): Promise<void> {
  const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  const data = await gql<{ sessionsByArena: Array<{ id: string }> }>(
    `query($arenaId: ID!, $from: DateTime!, $to: DateTime!) {
       sessionsByArena(arenaId: $arenaId, from: $from, to: $to) { id }
     }`,
    { arenaId, from: from.toISOString(), to: to.toISOString() },
  );
  for (const s of data.sessionsByArena) {
    await gql(`mutation($id: ID!) { deleteSession(id: $id) { __typename } }`, { id: s.id });
  }
}

export async function createSessionDirect(args: {
  arenaId: string;
  startTime: Date;
  durationMinutes: number;
  playerName?: string;
}): Promise<TestSession> {
  const data = await gql<{
    createSession:
      | { __typename: 'SessionPayload'; session: TestSession }
      | { __typename: string; message: string };
  }>(
    `mutation($input: CreateSessionInput!) {
       createSession(input: $input) {
         __typename
         ... on SessionPayload {
           session { id arenaId startTime endTime }
         }
         ... on SlotUnavailable { message }
         ... on ValidationFailed { issues { field message } }
         ... on NotFound { message }
       }
     }`,
    {
      input: {
        arenaId: args.arenaId,
        startTime: args.startTime.toISOString(),
        durationMinutes: args.durationMinutes,
        playerName: args.playerName ?? null,
      },
    },
  );
  const r = data.createSession;
  if (r.__typename !== 'SessionPayload') {
    throw new Error(`createSessionDirect failed: ${JSON.stringify(r)}`);
  }
  return (r as { session: TestSession }).session;
}

/** Navigate the UI to a specific arena and date. */
export async function gotoArenaOnDate(page: Page, arenaIndex: number, date: Date) {
  await page.goto('/');
  // Wait for arena list to populate. Use .first() to bypass strict mode while
  // we're just checking presence.
  await expect(page.getByRole('button', { name: /^Arena #/ }).first()).toBeVisible();

  // `exact: true` matters — without it "Arena #1" also matches Arena #10, #11, … #19.
  await page
    .getByRole('button', { name: `Arena #${arenaIndex}`, exact: true })
    .click();

  // Set the date input. The input has type="date" so we feed YYYY-MM-DD.
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dateInput = page.locator('input[type="date"]');
  await dateInput.fill(`${yyyy}-${mm}-${dd}`);

  // Wait for the timeline header to reflect the new date.
  await expect(page.getByRole('heading', { level: 2 })).toContainText(String(yyyy));
}
