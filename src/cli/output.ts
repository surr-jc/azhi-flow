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
