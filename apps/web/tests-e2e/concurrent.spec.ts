/**
 * Concurrent-booking simulation through real browsers.
 *
 * Why this exists separately from the backend race test in apps/api/tests/race.test.ts:
 *   - The backend test fires 20 calls from one Node process — proves the
 *     advisory lock works at the service-layer call site.
 *   - This test fires N calls from N INDEPENDENT browser contexts — proves
 *     the same property holds when each request comes through its own Apollo
 *     Client, over HTTP, hitting Fastify→Apollo→Pothos→service. The whole
 *     chain is exercised under contention, not just the lock in isolation.
 *
 * Two scenarios:
 *   1. N = 2 (under capacity)  → both succeed. Proves the lock doesn't cause
 *      spurious failures when there's no actual conflict.
 *   2. N = 7 (over capacity)   → exactly 5 succeed, 2 see "Slot unavailable"
 *      in the UI. Proves the cap is enforced even when 7 simultaneous
 *      requests land at the same instant.
 *
 * If either test goes red, the locking strategy has a hole.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  cleanArenaDay,
  gotoArenaOnDate,
  isolatedDate,
  pickFirstArenaId,
  toDatetimeLocalValue,
} from './helpers';

interface UserPage {
  ctx: BrowserContext;
  page: Page;
  label: string;
}

/**
 * Set up N independent users, each navigated to the same arena/date with the
 * create modal open and the form filled to target `slotStart`.
 */
async function setupNUsers(
  browser: import('@playwright/test').Browser,
  n: number,
  day: Date,
  slotStart: Date,
): Promise<UserPage[]> {
  const users: UserPage[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    users.push({ ctx, page, label: `User ${i + 1}` });
  }

  const localStartStr = toDatetimeLocalValue(slotStart);

  await Promise.all(
    users.map(async ({ page, label }) => {
      await gotoArenaOnDate(page, 1, day);
      // Open the create modal by clicking the timeline area.
      const timelineArea = page.locator('[role="button"][tabindex="0"]').first();
      const box = await timelineArea.boundingBox();
      if (!box) throw new Error(`No timeline for ${label}`);
      await page.mouse.click(box.x + box.width / 2, box.y + 600);
      await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();
      // Fill the SAME slot for every user.
      await page.getByLabel('Start time').fill(localStartStr);
      await page.getByLabel(/Duration/).fill('60');
      await page.getByLabel('Player name (optional)').fill(label);
    }),
  );

  return users;
}

/**
 * For each user, click Create simultaneously, then categorize the resulting
 * UI state into 'success' (modal closed) or 'unavailable' (SlotUnavailable
 * panel visible).
 */
async function raceAndCategorize(users: UserPage[]) {
  // Fire all submits as close to simultaneously as JS lets us.
  await Promise.all(
    users.map(({ page }) =>
      page.getByRole('button', { name: 'Create', exact: true }).click(),
    ),
  );

  const outcomes = await Promise.all(
    users.map(async ({ page, label }) => {
      const modalHeading = page.getByRole('heading', { name: 'New session' });
      const errorPanel = page.getByText(/Slot unavailable/i);
      try {
        await Promise.race([
          modalHeading.waitFor({ state: 'hidden', timeout: 20_000 }),
          errorPanel.waitFor({ state: 'visible', timeout: 20_000 }),
        ]);
      } catch {
        /* fall through — we'll inspect state below */
      }
      if (await errorPanel.isVisible()) return { label, outcome: 'unavailable' as const };
      if (!(await modalHeading.isVisible())) return { label, outcome: 'success' as const };
      return { label, outcome: 'stuck' as const };
    }),
  );

  const successes = outcomes.filter((o) => o.outcome === 'success');
  const unavailable = outcomes.filter((o) => o.outcome === 'unavailable');
  const stuck = outcomes.filter((o) => o.outcome === 'stuck');
  return { outcomes, successes, unavailable, stuck };
}

test.describe('concurrent UI bookings', () => {
  test.describe.configure({ timeout: 180_000 });

  test('2 users → no race: both succeed (cap not exceeded)', async ({ browser }) => {
    const arenaId = await pickFirstArenaId();
    const day = isolatedDate(10); // bucket 10 — far from other tests
    await cleanArenaDay(arenaId, day);

    const slotStart = new Date(day);
    slotStart.setUTCHours(15, 0, 0, 0);

    const users = await setupNUsers(browser, 2, day, slotStart);
    try {
      const { outcomes, successes, unavailable, stuck } = await raceAndCategorize(users);
      // eslint-disable-next-line no-console
      console.log('[concurrent N=2] outcomes:', outcomes);
      expect({
        successes: successes.length,
        unavailable: unavailable.length,
        stuck: stuck.length,
      }).toEqual({ successes: 2, unavailable: 0, stuck: 0 });
    } finally {
      await Promise.all(users.map(({ ctx }) => ctx.close()));
    }
  });

  test('7 users → cap enforced: synchronized Save click via starting gun', async ({
    browser,
  }) => {
    const N = 7;
    const arenaId = await pickFirstArenaId();
    const day = isolatedDate(11);
    await cleanArenaDay(arenaId, day);

    const slotStart = new Date(day);
    slotStart.setUTCHours(15, 0, 0, 0);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 1 — Open N browser contexts and navigate each user to the
    // arena/date. Each user is now looking at the timeline.
    // ─────────────────────────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`[concurrent N=${N}] PHASE 1: opening ${N} browser contexts and navigating...`);
    const users = await setupNUsers(browser, N, day, slotStart);

    try {
      // ───────────────────────────────────────────────────────────────────
      // PHASE 2 — Barrier: verify every user is fully ready — modal open,
      // form filled, Save button visible and enabled. NO ONE proceeds until
      // ALL N pass this check.
      // ───────────────────────────────────────────────────────────────────
      // eslint-disable-next-line no-console
      console.log(`[concurrent N=${N}] PHASE 2: verifying all ${N} users are at "Save ready" state...`);
      await Promise.all(
        users.map(async ({ page, label }) => {
          const modalHeading = page.getByRole('heading', { name: 'New session' });
          const saveBtn = page.getByRole('button', { name: 'Create', exact: true });
          await expect(modalHeading, `${label}: modal heading`).toBeVisible();
          await expect(saveBtn, `${label}: Save button`).toBeVisible();
          await expect(saveBtn, `${label}: Save button enabled`).toBeEnabled();
        }),
      );
      // eslint-disable-next-line no-console
      console.log(`[concurrent N=${N}]   ✓ all ${N} users ready at the line`);

      // ───────────────────────────────────────────────────────────────────
      // PHASE 3 — Starting gun. We arm N click-promises that are all parked
      // on a single shared Promise. When we resolve it, every chain enters
      // its `.then()` in the same event-loop microtask drain and fires its
      // .click() back-to-back with no test-side work in between.
      // ───────────────────────────────────────────────────────────────────
      let fireStartingGun!: () => void;
      const startingGun = new Promise<void>((resolve) => {
        fireStartingGun = resolve;
      });

      const dispatchOffsetMs: Record<string, number> = {};
      let t0 = 0;

      const submissions = users.map(({ page, label }) =>
        startingGun.then(() => {
          dispatchOffsetMs[label] = Date.now() - t0;
          return page
            .getByRole('button', { name: 'Create', exact: true })
            .click();
        }),
      );

      // Yield a couple of microtask ticks so the .then() handlers are
      // definitely all suspended on the gun before we fire.
      await new Promise((r) => setTimeout(r, 50));

      // eslint-disable-next-line no-console
      console.log(`[concurrent N=${N}] PHASE 3: 🔫 firing starting gun — all ${N} Save clicks released`);
      t0 = Date.now();
      fireStartingGun();
      await Promise.all(submissions);

      // eslint-disable-next-line no-console
      console.log(
        `[concurrent N=${N}]   click dispatch offsets (ms after gun):`,
        dispatchOffsetMs,
      );

      // ───────────────────────────────────────────────────────────────────
      // PHASE 4 — Collect outcomes. Each user's UI is now either showing
      // the modal closed (success) or the red "Slot unavailable" panel.
      // ───────────────────────────────────────────────────────────────────
      // eslint-disable-next-line no-console
      console.log(`[concurrent N=${N}] PHASE 4: collecting outcomes from ${N} users...`);

      const outcomes = await Promise.all(
        users.map(async ({ page, label }) => {
          const modalHeading = page.getByRole('heading', { name: 'New session' });
          const errorPanel = page.getByText(/Slot unavailable/i);
          try {
            await Promise.race([
              modalHeading.waitFor({ state: 'hidden', timeout: 20_000 }),
              errorPanel.waitFor({ state: 'visible', timeout: 20_000 }),
            ]);
          } catch {
            /* fall through and inspect below */
          }
          if (await errorPanel.isVisible()) return { label, outcome: 'unavailable' as const };
          if (!(await modalHeading.isVisible())) return { label, outcome: 'success' as const };
          return { label, outcome: 'stuck' as const };
        }),
      );

      const successes = outcomes.filter((o) => o.outcome === 'success');
      const unavailable = outcomes.filter((o) => o.outcome === 'unavailable');
      const stuck = outcomes.filter((o) => o.outcome === 'stuck');

      // eslint-disable-next-line no-console
      console.log(`[concurrent N=${N}] PHASE 4 result:`, {
        successes: successes.map((s) => s.label),
        unavailable: unavailable.map((s) => s.label),
        stuck: stuck.map((s) => s.label),
      });

      expect({
        successes: successes.length,
        unavailable: unavailable.length,
        stuck: stuck.length,
      }).toEqual({ successes: 5, unavailable: 2, stuck: 0 });
    } finally {
      await Promise.all(users.map(({ ctx }) => ctx.close()));
    }
  });
});
