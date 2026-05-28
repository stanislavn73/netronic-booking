import { test, expect } from '@playwright/test';
import {
  cleanArenaDay,
  createSessionDirect,
  gotoArenaOnDate,
  isolatedDate,
  pickFirstArenaId,
  toDatetimeLocalValue,
} from './helpers';

test.describe('booking system — end-to-end', () => {
  test('1) page loads and arenas appear in the sidebar', async ({ page }) => {
    await page.goto('/');
    // Header is up
    await expect(page.getByRole('heading', { name: 'Netronic Booking' })).toBeVisible();
    // At least one arena renders (use .first() to dodge strict mode during cold load).
    await expect(page.getByRole('button', { name: /^Arena #/ }).first()).toBeVisible();
    // Confirm Arena #1 specifically — exact: true so it doesn't match Arena #10..#19.
    await expect(
      page.getByRole('button', { name: 'Arena #1', exact: true }),
    ).toBeVisible();
    // Capacity badge is shown
    await expect(page.getByText(/5 concurrent sessions per arena/i)).toBeVisible();
  });

  test('2) selecting an arena shows the timeline', async ({ page }) => {
    const day = isolatedDate(0);
    await gotoArenaOnDate(page, 1, day);
    // Timeline hour labels render
    await expect(page.getByText('00:00').first()).toBeVisible();
    await expect(page.getByText('23:00').first()).toBeVisible();
  });

  test('3) create a session by clicking an empty timeline area', async ({ page }) => {
    const arenaId = await pickFirstArenaId();
    const day = isolatedDate(1);
    await cleanArenaDay(arenaId, day);
    await gotoArenaOnDate(page, 1, day);

    // Click somewhere mid-timeline to open the create modal.
    // The 24-hour grid is 1440px tall (24 × 60px). Clicking at y≈600px = ~10:00.
    const timelineArea = page.locator('[role="button"][tabindex="0"]').first();
    const box = await timelineArea.boundingBox();
    if (!box) throw new Error('No timeline area found');
    await page.mouse.click(box.x + box.width / 2, box.y + 600);

    // Modal opens
    await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();

    // Fill player name (start time + duration are pre-filled)
    await page.getByLabel('Player name (optional)').fill('E2E Test Player');

    // Submit
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // Modal closes
    await expect(page.getByRole('heading', { name: 'New session' })).toBeHidden();

    // The new session block shows the player name in the timeline
    await expect(page.getByText('E2E Test Player')).toBeVisible();
  });

  test('4) over-booking shows SlotUnavailable + suggestion chips', async ({ page }) => {
    const arenaId = await pickFirstArenaId();
    const day = isolatedDate(2);
    await cleanArenaDay(arenaId, day);

    // Pre-book 5 sessions at 10:00–11:00 via the API directly (faster than clicking).
    const slotStart = new Date(day);
    slotStart.setUTCHours(10, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      await createSessionDirect({
        arenaId,
        startTime: slotStart,
        durationMinutes: 60,
        playerName: `Pre-booked ${i + 1}`,
      });
    }

    await gotoArenaOnDate(page, 1, day);

    // Try to add a 6th via the UI.
    const timelineArea = page.locator('[role="button"][tabindex="0"]').first();
    const box = await timelineArea.boundingBox();
    if (!box) throw new Error('No timeline area found');
    await page.mouse.click(box.x + box.width / 2, box.y + 600); // ~10:00

    await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();

    // Set the form's start to the same INSTANT we pre-booked. The form is
    // datetime-local (browser interprets in local TZ), so we must give it the
    // local-time representation of slotStart, not just "10:00".
    const startInput = page.getByLabel('Start time');
    await startInput.fill(toDatetimeLocalValue(slotStart));
    await page.getByLabel(/Duration/).fill('60');

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // SlotUnavailable panel appears with suggestion chips.
    await expect(page.getByText(/Slot unavailable/i)).toBeVisible();
    await expect(page.getByText(/Nearest available slots/i)).toBeVisible();

    // At least one suggestion chip is visible and clickable.
    const chips = page.locator('button').filter({ hasText: /\d{2}:\d{2}/ }).filter({ hasNotText: /^\d{2}:\d{2}–/ });
    await expect(chips.first()).toBeVisible();

    // Clicking a chip updates the start-time input → close modal, no further assertion needed
    // beyond "the click does something". We just verify the chip is interactive.
    await chips.first().click();
    // After applying a suggestion, the error should clear.
    await expect(page.getByText(/Slot unavailable/i)).toBeHidden();
  });

  test('5) edit an existing session', async ({ page }) => {
    const arenaId = await pickFirstArenaId();
    const day = isolatedDate(3);
    await cleanArenaDay(arenaId, day);

    const start = new Date(day);
    start.setUTCHours(14, 0, 0, 0);
    await createSessionDirect({
      arenaId,
      startTime: start,
      durationMinutes: 30,
      playerName: 'Original Name',
    });

    await gotoArenaOnDate(page, 1, day);

    // Click the existing session block — it shows the player name as text.
    await page.getByText('Original Name').click();

    await expect(page.getByRole('heading', { name: 'Edit session' })).toBeVisible();

    await page.getByLabel('Player name (optional)').fill('Edited Name');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Edit session' })).toBeHidden();
    await expect(page.getByText('Edited Name')).toBeVisible();
    await expect(page.getByText('Original Name')).toBeHidden();
  });

  test('6) cancel a session removes it from the timeline', async ({ page }) => {
    const arenaId = await pickFirstArenaId();
    const day = isolatedDate(4);
    await cleanArenaDay(arenaId, day);

    const start = new Date(day);
    start.setUTCHours(16, 0, 0, 0);
    await createSessionDirect({
      arenaId,
      startTime: start,
      durationMinutes: 45,
      playerName: 'To Be Cancelled',
    });

    await gotoArenaOnDate(page, 1, day);

    await page.getByText('To Be Cancelled').click();
    await expect(page.getByRole('heading', { name: 'Edit session' })).toBeVisible();

    // The cancel-session button shows a confirm() dialog; auto-accept.
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Cancel session' }).click();

    await expect(page.getByRole('heading', { name: 'Edit session' })).toBeHidden();
    await expect(page.getByText('To Be Cancelled')).toBeHidden();
  });
});
