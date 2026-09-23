// The room end to end against `?mock`: the real engine, lathe and UI with the in-page simulation
// standing in for the server (see src/client/room/mock.ts). Runs in both projects (desktop, Pixel 7).
import { expect, test } from '@playwright/test';
import { app, dropNeedle, expectRunning, isPhone, openLanding, showPanel } from './helpers.ts';

test.describe('landing', () => {
  test('renders, and the record spins in sync before the unlock', async ({ page }) => {
    await openLanding(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Claude\s*B.Side/i);
    await expect(page.getByText(/Live now · \d+ in the room/i)).toBeVisible();
    await expect(page.getByText(/Now cutting:/)).toContainText('Side A, Track 2');
    await expect(page.locator('.record canvas.live')).toBeVisible();
    await expect(app(page)).not.toHaveAttribute('data-engine-state', 'running');

    // The platter turns: two frames of the record a beat apart differ.
    const record = page.locator('.record');
    await page.waitForTimeout(1200);
    const a = await record.screenshot();
    await page.waitForTimeout(700);
    const b = await record.screenshot();
    expect(a.equals(b)).toBe(false);
    await expect(app(page)).not.toHaveAttribute('data-engine-state', 'running');
  });
});

test.describe('the room (mock)', () => {
  test.beforeEach(async ({ page }) => {
    await openLanding(page);
    await dropNeedle(page);
  });

  test('dropping the needle starts the audio engine', async ({ page }) => {
    await expectRunning(page);
    await expect(page.getByRole('banner')).toContainText('Glass Harbour');
  });

  test('the code view shows the parts and lights sounding atoms', async ({ page }) => {
    await showPanel(page, 'code');
    const rows = page.locator('.code-view article');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.code-view')).toContainText('kick: s("sbd*4")');
    await expect(page.locator('.code-view .atom.on').first()).toBeVisible({ timeout: 10_000 });
  });

  test('dragging on the pad moves your puck and leans the room', async ({ page }) => {
    await showPanel(page, 'pull');
    const pad = page.locator('.pad canvas');
    await expect(pad).toBeVisible();
    await expect(page.locator('#pull-x')).toHaveAttribute('aria-valuetext', 'neutral');
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#pull-x')).toHaveAttribute('aria-valuetext', /brighter/);
    await expect(page.locator('#pull-y')).toHaveAttribute('aria-valuetext', /intense/);
    await expect(page.locator('.pull .me')).toContainText('You lean');
  });

  test('the pad works from the keyboard', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'keyboard path is covered on desktop');
    await page.keyboard.press('p');
    await expect(page.locator('#pull-x')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.locator('#pull-x')).toHaveAttribute('aria-valuetext', 'darker');
  });

  test('the pad follows a screen reader adjusting its sliders', async ({ page }) => {
    await showPanel(page, 'pull');
    const x = page.locator('#pull-x');
    await expect(x).toHaveAttribute('aria-valuetext', 'neutral');
    // What VoiceOver and TalkBack do to a native range: set the value, fire input and change, no keys.
    for (let i = 0; i < 3; i++) {
      await x.evaluate((el: HTMLInputElement) => {
        el.stepUp();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await expect(x).toHaveAttribute('aria-valuetext', /brighter/);
    await expect(x).toHaveValue('0.15');
    await expect(page.locator('.pull .me')).toContainText('You lean');
  });

  test('the pad and the record follow a pixel-ratio change that resizes nothing', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'a desktop window dragged to another screen');
    await showPanel(page, 'pull');
    const pad = page.locator('.pad canvas');
    const record = page.locator('.record canvas.live');
    await expect(record).toBeVisible();
    const ratio = (c: HTMLCanvasElement) => c.width / c.clientWidth;
    await expect.poll(() => pad.evaluate(ratio)).toBeCloseTo(1, 1);
    await expect.poll(() => record.evaluate(ratio)).toBeCloseTo(1, 1);
    const viewport = page.viewportSize()!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 2, mobile: false });
    await expect.poll(() => pad.evaluate(ratio)).toBeCloseTo(2, 1);
    // The record's tier may cap it at 1.5 on a slow machine; either way it is no longer drawn at 1×.
    await expect.poll(() => record.evaluate(ratio)).toBeGreaterThanOrEqual(1.5);
  });

  test('the desktop room fits one viewport; "?" says what is playing', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'desktop layout');
    const [height, viewport] = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
    expect(height).toBeLessThanOrEqual(viewport);
    await page.keyboard.press('?');
    const summary = page.getByRole('region', { name: 'What’s playing' });
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('Glass Harbour');
    await expect(summary).toContainText(/kick — Synth kick, playing/);
    await page.keyboard.press('Escape');
    await expect(summary).toHaveCSS('width', '1px');
  });

  test('reactions confirm, and cool down like the server’s rate limit', async ({ page }) => {
    const yes = page.getByRole('button', { name: 'Yes', exact: true });
    await expect(yes).toBeVisible();
    await yes.click();
    await expect(page.locator('.dock .line')).toContainText('etched into the rim');
    // The bucket holds 5 (RATE_LIMITS.reaction); a slow machine may earn one back meanwhile.
    for (let i = 0; i < 6 && (await yes.getAttribute('aria-disabled')) !== 'true'; i++) await yes.click();
    await expect(yes).toHaveAttribute('aria-disabled', 'true');
    // Still focusable and pressable while cooling down (aria-disabled, not disabled): it explains itself.
    await yes.click({ force: true });
    await expect(page.locator('.dock .line')).toContainText('give it a second');
    // Stay and Move on have their own bucket, and remember the ballot for this track.
    const stay = page.getByRole('button', { name: 'Stay', exact: true });
    await stay.click();
    await expect(stay).toHaveAttribute('aria-pressed', 'true');
  });

  test('a request shows as received, only to you', async ({ page }) => {
    await showPanel(page, 'ask');
    await page.locator('#ask-input').fill('a glassy bell line, please');
    await page.getByRole('button', { name: 'Send' }).click();
    const mine = page.locator('.asks .card.mine').first();
    await expect(mine).toContainText('received');
    await expect(mine).toContainText('a glassy bell line, please');
    await expect(page.locator('#ask-input')).toHaveValue('');
  });

  test('the vote is a radio group you can answer', async ({ page }) => {
    await showPanel(page, 'vote');
    const group = page.getByRole('group', { name: /Where should the harbour go next/ });
    await expect(group).toBeVisible();
    await group.getByText('Double-time hats').click();
    await expect(group.getByRole('radio', { name: /Double-time hats/ })).toBeChecked();
    await expect(page.locator('.vote .foot')).toContainText('you picked B');
  });

  test('arrowing through the vote settles on the last option', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'keyboard path is covered on desktop');
    await showPanel(page, 'vote');
    const group = page.getByRole('group', { name: /Where should the harbour go next/ });
    await group.getByRole('radio').first().focus();
    // Every arrow checks, and so votes for, the next option: A → B → C → A → B. Four votes in a
    // second are one more than the room's vote bucket holds (the mock refuses it like the server).
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await expect(page.locator('.vote .foot')).toContainText('you picked B');
    // Past the time a pick is shown on its own, what the room counted still says B.
    await page.waitForTimeout(5000);
    await expect(group.getByRole('radio').nth(1)).toBeChecked();
    await expect(page.locator('.vote .foot')).toContainText('you picked B');
    await expect(page.locator('.vote .problem')).toHaveCount(0);
  });
});

test.describe('copying the code', () => {
  test('writes the clipboard inside the click, as Safari requires', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // WebKit only lets a page write the clipboard while the click is being dispatched, not after an await.
    await page.addInitScript(() => {
      let dispatching = false;
      addEventListener('click', () => (dispatching = true), true);
      addEventListener('click', () => (dispatching = false));
      const clipboard = navigator.clipboard;
      const write = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text: string) => (dispatching ? write(text) : Promise.reject(new DOMException('outside the gesture', 'NotAllowedError')));
    });
    await openLanding(page);
    await dropNeedle(page);
    await showPanel(page, 'code');
    const copy = page.locator('.code-view .actions .act').nth(1);
    await expect(copy).toBeEnabled();
    // Until the catalog has loaded a click can only copy after awaiting it; from then on, inside the click.
    await expect
      .poll(
        async () => {
          await copy.click();
          await page.waitForTimeout(200);
          return copy.textContent();
        },
        { timeout: 10_000 },
      )
      .toContain('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('setcpm(');
  });
});

test.describe('reduced motion', () => {
  test('defaults to calm visuals', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openLanding(page);
    await expect(app(page)).toHaveAttribute('data-calm', 'true');
    await dropNeedle(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: /Calm visuals/ })).toBeChecked();
  });
});

test.describe('phone layout', () => {
  test('never scrolls sideways, and the dock stays in reach', async ({ page }, info) => {
    test.skip(!isPhone(info.project.name), 'phone project only');
    const noSideways = async () => {
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scroll).toBeLessThanOrEqual(width);
    };
    await openLanding(page);
    await noSideways();
    await dropNeedle(page);
    const viewport = page.viewportSize()!;
    for (const tab of ['pull', 'code', 'vote', 'ask'] as const) {
      await page.locator(`[data-tab-id="${tab}"]`).click();
      await expect(page.locator(`[data-tab-id="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
      await noSideways();
      const dock = (await page.locator('nav.dock').boundingBox())!;
      expect(dock.y + dock.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(dock.y).toBeGreaterThan(viewport.height / 2);
    }
    for (const name of ['Yes', 'Stay', 'Move on', 'Too much']) {
      const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(48);
    }
  });
});
