import type { RunPlanReport } from '../plan/run-plan.js';
import type { Diagnostic } from '../definition/load.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const dim = c(2);
export const bold = c(1);

export function printDiagnostics(diags: Diagnostic[]) {
  for (const d of diags) {
    const tag = d.severity === 'error' ? red('error') : d.severity === 'warning' ? yellow('warning') : dim('info');
    const where = d.node ? ` [${d.node}${d.path ? ` ${d.path}` : ''}]` : d.path ? ` [${d.path}]` : '';
    console.log(`${tag} ${d.code}${where}: ${d.message}`);
  }
}

export function table(rows: string[][]) {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  for (const r of rows) console.log(r.map((cell, i) => cell + ' '.repeat(widths[i]! - stripAnsi(cell).length)).join('  ').trimEnd());
}

function stripAnsi(s: string) {
  return s.replace(/\x1b\[\d+m/g, '');
}

const MARK_COLOUR = { native: green, bridged: yellow, unverified: yellow, unsupported: red } as const;
const ENFORCEMENT_COLOUR = { enforced: green, harness: yellow, unobservable: red } as const;

export function printPlan(p: RunPlanReport) {
  console.log(`${bold(`${p.workflow}@${p.version}`)} ${dim(p.package_hash.slice(0, 19))}`);
  console.log(`signer: ${p.signer.verified ? green(p.signer.publisher ?? '') : red(`unverified (${p.signer.error ?? 'unsigned'})`)}`);
  for (const n of p.nodes) {
    console.log(`\n${bold(n.id)} ${dim(n.type + (n.executor ? ` · ${n.executor}` : ''))}${n.tainted ? ` ${yellow(`tainted: ${n.tainted}`)}` : ''}`);
    for (const r of n.requirements) console.log(`  ${MARK_COLOUR[r.mark](r.mark.padEnd(13))} ${r.name} ${dim(r.detail)}`);
    for (const c of n.coverage) console.log(`  ${ENFORCEMENT_COLOUR[c.enforcement](c.enforcement.padEnd(13))} ${c.action} ${dim(c.detail)}`);
  }
  if (p.taint.paths.length) {
    console.log(`\n${bold('taint paths')}`);
    for (const t of p.taint.paths) console.log(`  ${t.gate ? green('gated') : red('ungated')} ${t.path.join(' → ')}${t.tool ? ` via ${t.tool}` : ''} ${dim(t.gate ? `by ${t.gate}` : '')}`);
  }
  if (p.missing_grants.length) {
    console.log(`\n${bold('missing grants')}`);
    for (const g of p.missing_grants) console.log(`  ${red('✗')} ${g.kind} ${g.name} ${dim(`(${g.node})`)}`);
  }
  if (p.worker_trust.length) {
    console.log(`\n${bold('workers')}`);
    for (const w of p.worker_trust) console.log(`  ${w.accepted ? green('✓') : red('✗')} ${w.name} ${dim(JSON.stringify(w.policy))}${w.reason ? ` ${red(w.reason)}` : ''}`);
  }
  console.log('');
  if (p.ok) console.log(green('plan ok: nothing blocks this run'));
  else for (const b of p.blockers) console.log(`${red('blocked')} ${b.code}${b.node ? ` (${b.node})` : ''}: ${b.message}`);
}
