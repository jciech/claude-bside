// Shared steps for the end-to-end suite. `?mock` runs the whole room in the page (no server state);
// the live specs talk to the real server started by playwright.config.ts (scripted composer).
import { expect, type BrowserContext, type Page } from '@playwright/test';

/** The sandbox browser can't reach GitHub directly; fetch sample assets through Node instead. */
export async function routeSamples(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/raw\.githubusercontent\.com\//, async (route) => {
    try {
      const res = await fetch(route.request().url());
      await route.fulfill({
        status: res.status,
        body: Buffer.from(await res.arrayBuffer()),
        headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'access-control-allow-origin': '*' },
      });
    } catch {
      await route.abort();
    }
  });
}

export const app = (page: Page) => page.locator('.app');

export async function openLanding(page: Page, query = '?mock'): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByRole('button', { name: 'Drop the needle' })).toBeVisible();
}

export async function dropNeedle(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Drop the needle' }).click();
  await expect(app(page)).toHaveAttribute('data-mode', 'room');
  await expect(app(page)).toHaveAttribute('data-entering', 'false');
}

export async function expectRunning(page: Page): Promise<void> {
  await expect(app(page)).toHaveAttribute('data-engine-state', 'running', { timeout: 30_000 });
}

/** On a phone only one panel shows at a time. */
export async function showPanel(page: Page, tab: 'code' | 'pull' | 'vote' | 'ask'): Promise<void> {
  const button = page.locator(`[data-tab-id="${tab}"]`);
  if (await button.isVisible()) await button.click();
}

export const isPhone = (projectName: string) => projectName === 'phone';
