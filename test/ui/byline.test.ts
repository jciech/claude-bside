import { describe, expect, it } from 'vitest';
import { composerByline, trackArtist } from '../../src/client/ui/format.ts';

describe('record label byline', () => {
  it('names whoever is composing', () => {
    expect(composerByline('claude')).toBe('Claude · live');
    expect(composerByline('external')).toBe('Guest composer · live');
    expect(composerByline('scripted')).toBe('Autopilot · live');
  });

  it('credits each track to the composer that wrote it', () => {
    expect(trackArtist('claude')).toBe('Claude');
    expect(trackArtist('external')).toBe('Guest composer');
    expect(trackArtist('scripted')).toBe('Autopilot');
  });
});
