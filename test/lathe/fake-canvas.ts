// A 2D canvas stand-in for running the Lathe in Node: every drawing call is a no-op, gradients are
// recorded (with their colour stops) so tests can tell which layers a frame drew.

export interface GradientCall {
  kind: 'linear' | 'radial' | 'conic';
  args: number[];
  stops: string[];
}

export class FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  readonly gradients: GradientCall[] = [];
  private ctx: unknown = null;

  constructor(width = 300, height = 150) {
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
  }

  getContext(kind: string): unknown {
    if (kind !== '2d') return null;
    this.ctx ??= fakeContext(this);
    return this.ctx;
  }
}

function fakeContext(canvas: FakeCanvas): unknown {
  const props: Record<string | symbol, unknown> = { canvas };
  const gradient = (kind: GradientCall['kind']) => (...args: number[]) => {
    const call: GradientCall = { kind, args, stops: [] };
    canvas.gradients.push(call);
    return { addColorStop: (_offset: number, color: string) => void call.stops.push(color) };
  };
  const methods: Record<string, unknown> = {
    createLinearGradient: gradient('linear'),
    createRadialGradient: gradient('radial'),
    createConicGradient: gradient('conic'),
    measureText: (text: string) => ({ width: 6 * text.length }),
  };
  return new Proxy(props, {
    get: (target, key) => (key in target ? target[key] : (methods[key as string] ?? (() => undefined))),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
}

/** Conic gradients with coloured stops: the record's sheen (the loupe's lens is plain rgba). */
export function sheens(canvas: FakeCanvas): GradientCall[] {
  return canvas.gradients.filter((g) => g.kind === 'conic' && g.stops.some((s) => s.startsWith('hsl(')));
}
