// Typed view of the generated allowlist (scripts/gen-allowlist.ts). Server and client import the
// same JSON, so validation gives identical answers everywhere.
import data from './allowlist.generated.json' with { type: 'json' };

export interface Allowlist {
  /** Identifiers part code may reference (Strudel exports, plus `knob`). */
  globals: ReadonlySet<string>;
  /** Names allowed after a dot on a pattern. */
  methods: ReadonlySet<string>;
  /** Control names: the only legal object-literal keys. */
  controls: ReadonlySet<string>;
  /** Composer accessors that take a mode: `pat.add.squeeze(...)`. */
  operators: ReadonlySet<string>;
  operatorModes: ReadonlySet<string>;
  /** In the evaluation scope (emitted by the transpiler) but not writable in source. */
  scopeOnly: ReadonlySet<string>;
  /** Deliberately unavailable names → why. */
  denied: ReadonlyMap<string, string>;
  strudel: Readonly<Record<string, string>>;
}

export const ALLOWLIST: Allowlist = {
  globals: new Set(data.globals),
  methods: new Set(data.methods),
  controls: new Set(data.controls),
  operators: new Set(data.operators),
  operatorModes: new Set(data.operatorModes),
  scopeOnly: new Set(data.scopeOnly),
  denied: new Map(Object.entries(data.denied)),
  strudel: data.strudel,
};
