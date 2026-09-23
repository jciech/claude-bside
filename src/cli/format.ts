// Human-readable output for the bside CLI: a status table, issues with line/column and hints, audition
// digests, commit results and one line per streamed event. Colour only when asked for.
import type { Issue, PartDigest } from '../shared/analysis.ts';
import type { AuditionResult, CommitResult, ComposerApiStatus, PlanRequest } from '../shared/composer-api.ts';
import type { SectionProgram } from '../shared/program.ts';

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

const ansi = (code: number) => (s: string) => `\u001b[${code}m${s}\u001b[0m`;
export const COLOR: Style = { bold: ansi(1), dim: ansi(2), red: ansi(31), green: ansi(32), yellow: ansi(33) };
const id = (s: string) => s;
export const PLAIN: Style = { bold: id, dim: id, red: id, green: id, yellow: id };

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const q = (s: string) => `"${s}"`;

/** Aligns rows into columns two spaces apart; a row's last cell runs free and sets no width. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.slice(0, -1).forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n');
}

export function formatStatus(s: ComposerApiStatus, st: Style): string {
  const head = `${st.bold('B-Side')}  epoch ${s.epoch} · driver ${st.bold(s.driver)} · cycle ${s.cycle.toFixed(1)} · ${Math.round(s.bpm * 10) / 10} BPM · horizon ${Math.round(s.horizonSec)} s`;
  const rows: string[][] = [];
  if (s.now) rows.push(['now', s.now.id, q(s.now.name), s.now.role, `${s.now.barsLeft} bars left`]);
  for (const c of s.committed) rows.push(['next', c.id, q(c.name), `@${c.startCycle}`, c.provisional ? 'provisional' : 'locked']);
  if (s.pending) {
    const p = s.pending;
    const why = p.context.request.reasons.join(', ') || '—';
    rows.push(['pending', p.id, p.kind, `${why} · starts @${p.targetCycle} · soft in ${secs(p.softDeadlineMs - s.serverTime)} · hard in ${secs(p.hardDeadlineMs - s.serverTime)}`]);
  } else {
    rows.push(['pending', st.dim('none')]);
  }
  return `${head}\n${table(rows)}`;
}

export function formatIssue(i: Issue, st: Style): string {
  const mark = i.severity === 'error' ? st.red('✗') : st.yellow('!');
  const lines = [`${mark} ${i.path ? `${st.bold(i.path)}  ` : ''}${i.rule}`, `  ${i.message}`];
  if (i.line) {
    const excerpt = (i.excerpt ?? '').split('\n');
    const pos = `${i.line}:${i.column ?? 1}`;
    lines.push(`  ${st.dim(pos)}  ${excerpt[0] ?? ''}`);
    if (excerpt[1] !== undefined) lines.push(`  ${' '.repeat(pos.length)}  ${excerpt[1]}`);
  } else if (i.excerpt) {
    lines.push(...i.excerpt.split('\n').map((l) => `  ${l}`));
  }
  if (i.hint) lines.push(`  ${st.dim('hint:')} ${i.hint}`);
  return lines.join('\n');
}

export const formatIssues = (issues: readonly Issue[], st: Style) => issues.map((i) => formatIssue(i, st)).join('\n');

function digestLine(d: PartDigest): string {
  const bits = [d.instrument || '?', `${d.evPerBar} ev/bar`];
  if (d.register) bits.push(d.register);
  if (d.keyFit !== null) bits.push(`key fit ${Math.round(d.keyFit * 100)}%`);
  bits.push(`loud ${d.loud}`, `bright ${d.bright}`, `sync ${d.sync}`);
  if (d.period !== null) bits.push(`period ${d.period}`);
  return bits.join(' · ');
}

export function formatAudition(r: AuditionResult, st: Style, title?: string): string {
  const out: string[] = title ? [st.bold(title)] : [];
  for (const p of r.parts) {
    out.push(`${p.ok ? st.green('✓') : st.red('✗')} ${st.bold(p.id)}  ${p.digest ? digestLine(p.digest) : st.dim('no analysis')}`);
    for (const i of [...p.errors, ...p.warnings]) out.push(formatIssue(i, st).replace(/^/gm, '  '));
  }
  if (r.errors.length || r.warnings.length) {
    out.push(`${r.errors.length ? st.red('✗') : st.yellow('!')} ${st.bold('section')}`);
    for (const i of [...r.errors, ...r.warnings]) out.push(formatIssue(i, st).replace(/^/gm, '  '));
  }
  if (r.mix) {
    const d = r.mix.descriptors;
    out.push(st.dim(`mix: intensity ${d.intensity} · brightness ${d.brightness} · density ${d.density} · tension ${d.tension} · ${r.mix.onsetsPerBar} onsets/bar · peak overlap ${r.mix.peakOverlapGain}`));
  }
  return out.join('\n');
}

export function formatCommit(r: CommitResult, st: Style): string {
  const out: string[] = [];
  if (r.accepted) {
    out.push(st.green('✓ accepted'));
    for (const s of r.sections) out.push(`  ${s.id}  ${q(s.name)}  @${s.startCycle}  ${s.bars} bars`);
  } else {
    out.push(st.red(`✗ rejected (${r.errors.length} error${r.errors.length === 1 ? '' : 's'})`));
    out.push(formatIssues(r.errors, st));
  }
  if (r.warnings.length) out.push(st.yellow(`${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}:`), formatIssues(r.warnings, st));
  return out.join('\n');
}

export function formatEvent(event: string, data: unknown, st: Style, at: Date = new Date()): string {
  const time = st.dim(at.toTimeString().slice(0, 8));
  switch (event) {
    case 'request': {
      const r = data as PlanRequest;
      return `${time}  ${st.bold('request')}  ${r.id}  ${r.kind}  ${r.context.request.reasons.join(', ')}  starts @${r.targetCycle}  soft in ${r.context.request.softDeadlineSec} s  hard in ${r.context.request.hardDeadlineSec} s`;
    }
    case 'section': {
      const s = data as SectionProgram;
      return `${time}  ${st.bold('section')}  ${s.id}  ${q(s.name)}  ${s.role}  @${s.startCycle}+${s.bars}  ${s.author}${s.provisional ? '  provisional' : ''}`;
    }
    case 'started':
      return `${time}  ${st.green('started')}  ${(data as { sectionId: string }).sectionId}`;
    case 'revoke':
      return `${time}  ${st.yellow('revoked')}  ${(data as { sectionId: string }).sectionId}`;
    case 'status': {
      const s = data as ComposerApiStatus;
      return `${time}  status  driver ${s.driver}  cycle ${s.cycle.toFixed(1)}  horizon ${Math.round(s.horizonSec)} s  pending ${s.pending?.id ?? 'none'}`;
    }
    default:
      return `${time}  ${event}  ${JSON.stringify(data)}`;
  }
}
