import { describe, expect, it } from 'vitest';
import { composerByline } from '../../src/client/ui/format.ts';

describe('record label byline', () => {
  it('names whoever is composing', () => {
    expect(composerByline('claude')).toBe('Claude · live');
    expect(composerByline('external')).toBe('Guest composer · live');
    expect(composerByline('scripted')).toBe('Autopilot · live');
  });
});
