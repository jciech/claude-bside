// Command-line parsing for `bside`: a command, positionals, and --flags (`--flag value`,
// `--flag=value`, or bare booleans). Unknown flags are errors, so typos never pass silently.

export const COMMANDS = ['status', 'context', 'reference', 'audition', 'commit', 'driver', 'plan', 'watch', 'help'] as const;
export type Command = (typeof COMMANDS)[number];

const VALUE_FLAGS = new Set(['url', 'token', 'code', 'role', 'id', 'scale', 'bpm', 'bars', 'knob', 'request']);
const BOOLEAN_FLAGS = new Set(['json', 'now', 'next', 'help', 'no-color', 'chromatic']);

export interface Args {
  command: Command;
  positionals: string[];
  /** Value flags in order of appearance (repeatable, e.g. --knob). */
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h') {
      booleans.add('help');
      continue;
    }
    if (!arg.startsWith('--') || arg === '--') {
      if (arg !== '--') positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      booleans.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      values.set(name, [...(values.get(name) ?? []), value]);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  const [first, ...rest] = positionals;
  if (first === undefined) return { command: 'help', positionals: [], values, booleans };
  if (!(COMMANDS as readonly string[]).includes(first)) throw new UsageError(`unknown command "${first}"`);
  return { command: first as Command, positionals: rest, values, booleans };
}

export const value = (args: Args, name: string): string | undefined => args.values.get(name)?.at(-1);

export function numberValue(args: Args, name: string): number | undefined {
  const raw = value(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number (got "${raw}")`);
  return n;
}

export const USAGE = `bside — play along with (or instead of) Claude in a B-Side room

Usage: npm run bside -- <command> [options]

Commands:
  status                      driver, pending request, what's playing, the horizon
  context                     the TurnContext a composer would get now (JSON)
  reference                   the composer system prompt and Strudel reference card
  audition <file|->           try parts: an AuditionInput, a parts array, or a whole Plan
  audition --code '<strudel>' [--role r] [--id x] [--scale D:dorian] [--bpm n] [--bars n]
                              [--knob name=default:min:max[:follows]] [--chromatic]
  commit <file|-> [--now|--next] [--request <id>|pending]
                              commit a Plan (or {plan, mode, requestId}); --request pending
                              fulfils whatever request is waiting
  driver external|claude|scripted
                              switch who composes (aborts a request in flight)
  plan                        ask the conductor to plan now
  watch                       stream planning requests, sections and starts

Options:
  --url <base>                server (default $BSIDE_URL or http://localhost:3000)
  --token <token>             admin token (default $BSIDE_ADMIN_TOKEN)
  --json                      raw JSON output
  --no-color                  plain output (also NO_COLOR=1)

Exit codes: 0 ok · 1 rejected, failed or unreachable · 2 usage error`;
