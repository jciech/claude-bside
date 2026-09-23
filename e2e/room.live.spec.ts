// Against the real server (playwright.config.ts starts it with the scripted composer): hello /
// welcome over the websocket, the engine on the shared clock, and gestures reaching the room.
// These need the server; the in-page equivalents are in room.mock.spec.ts.
import { expect, test, type Page } from '@playwright/test';
import { app, dropNeedle, expectRunning, openLanding, routeSamples, showPanel } from './helpers.ts';

/** Everything the page sends over the room's websocket, as socket.io text frames. */
function recordFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && frames.push(f.payload)));
  return frames;
}

test.describe('the live room (server)', () => {
  test.beforeEach(async ({ context }) => {
    await routeSamples(context);
  });

  test('welcome brings the room: the landing names the track and the record syncs', async ({ page }) => {
    const frames = recordFrames(page);
    await openLanding(page, '');
    await expect(app(page)).toHaveAttribute('data-connection', 'live', { timeout: 20_000 });
    await expect(page.getByText(/Now cutting:/)).toContainText(/Side [A-Z]+, Track \d+/);
    await expect(page.locator('.record canvas.live')).toBeVisible({ timeout: 20_000 });
    // The server runs the scripted composer: the label credits the autopilot, not Claude.
    await expect(page.locator('.record .label-by')).toHaveText('Autopilot · live');
    expect(frames.some((f) => f.startsWith('42["hello"'))).toBe(true);
    expect(frames.some((f) => /^4\d+\["clock"\]/.test(f))).toBe(true);
  });

  test('dropping the needle starts the engine and the heartbeat says so', async ({ page }) => {
    const frames = recordFrames(page);
    await openLanding(page, '');
    await expect(app(page)).toHaveAttribute('data-connection', 'live', { timeout: 20_000 });
    await dropNeedle(page);
    await expectRunning(page);
    await expect.poll(() => frames.some((f) => f.includes('"heartbeat"') && f.includes('"audible":true')), { timeout: 15_000 }).toBe(true);
  });

  test('dragging on the pad sends pad frames', async ({ page }) => {
    const frames = recordFrames(page);
    await openLanding(page, '');
    await expect(app(page)).toHaveAttribute('data-connection', 'live', { timeout: 20_000 });
    await dropNeedle(page);
    await showPanel(page, 'pull');
    const box = (await page.locator('.pad canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => frames.filter((f) => f.startsWith('42["pad"')).length).toBeGreaterThanOrEqual(2);
    expect(frames.filter((f) => f.startsWith('42["pad"')).at(-1)).toContain('"active":false');
  });

  test('a request is received once the listener has been listening a few seconds', async ({ page }) => {
    test.setTimeout(90_000);
    await openLanding(page, '');
    await expect(app(page)).toHaveAttribute('data-connection', 'live', { timeout: 20_000 });
    await dropNeedle(page);
    await expectRunning(page);
    // The server ignores inputs for the first 10 s of audible listening.
    await page.waitForTimeout(12_000);
    await showPanel(page, 'ask');
    await page.locator('#ask-input').fill('more space in the low end');
    await page.getByRole('button', { name: 'Send' }).click();
    const mine = page.locator('.asks .card.mine').first();
    await expect(mine).toContainText('more space in the low end');
    await expect(mine).toContainText(/received|weighing|coming up/);
  });
});
