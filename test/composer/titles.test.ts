import { describe, expect, it } from 'vitest';
import { baseTitle, pickTitle } from '../../src/server/composer/autopilot.ts';

const TITLES = ['Click Theory', 'Nine Rooms', 'Small Hours'];

describe('autopilot section titles', () => {
  it('uses every title once before any comes back', () => {
    const used: string[] = [];
    for (let i = 0; i < TITLES.length; i++) used.push(pickTitle(TITLES, used, i));
    expect(new Set(used)).toEqual(new Set(TITLES));
  });

  it('numbers a title that comes back, starting with the one heard longest ago', () => {
    const used = ['Nine Rooms', 'Click Theory', 'Small Hours'];
    const fourth = pickTitle(TITLES, used, 0);
    expect(fourth).toBe('Nine Rooms II');
    const fifth = pickTitle(TITLES, [...used, fourth], 0);
    expect(fifth).toBe('Click Theory II');
    expect(pickTitle(TITLES, [...used, fourth, fifth, 'Small Hours II'], 0)).toBe('Nine Rooms III');
  });

  it('recognises the library title behind a numbered one', () => {
    expect(baseTitle('Nine Rooms III')).toBe('Nine Rooms');
    expect(baseTitle('Nine Rooms')).toBe('Nine Rooms');
    expect(baseTitle('Five in Sixteen')).toBe('Five in Sixteen');
  });
});
