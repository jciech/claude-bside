import { describe, expect, it } from 'vitest';
import type { UserConfig } from 'vite';
import config from '../../vite.config.ts';

describe('client build', () => {
  it('never inlines fonts (the production CSP only allows font-src self)', () => {
    const limit = (config as UserConfig).build?.assetsInlineLimit;
    if (typeof limit !== 'function') throw new Error('assetsInlineLimit must decide per file');
    const tiny = Buffer.alloc(512);
    expect(limit('/node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-ext-wght-normal.woff2', tiny)).toBe(false);
    expect(limit('/src/client/public/favicon.svg', tiny)).toBeUndefined();
  });
});
