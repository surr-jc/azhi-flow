import { bold, dim, green, red, table, yellow } from './output.js';

const stateColor = (s: string) => (s === 'succeeded' || s === 'confirmed' ? green(s) : ['failed', 'delivery_failed', 'expired', 'outcome_unknown'].includes(s) ? red(s) : yellow(s));

/** Prints a run the way an operator investigates it: state and flags, nodes and attempts, ledger. */
export function printInspect(d: any) {
  const r = d.run;
  console.log(`\n${bold(r.id)}  ${r.workflow}@${r.workflow_version}  ${stateColor(r.state)}  trigger=${r.trigger}`);
  const flags = Object.entries(r.flags ?? {}).filter(([, v]) => v !== undefined && v !== false);
  if (flags.length) console.log(`flags: ${flags.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}`);
  if (r.error) console.log(red(`error: [${r.error.class}] ${r.error.message}`));
  console.log(dim(`reference time ${r.snapshot.reference_time}  interpreter ${r.interpreter_build}  package ${r.snapshot.package_hash.slice(0, 19)}`));

  if (d.attempts.length) {
    console.log(`\n${bold('Nodes')}`);
    table([
      ['NODE', 'ATTEMPT', 'STATE', 'WORKER', 'DURATION', 'ERROR'],
      ...d.attempts.map((a: any) => [
        a.node_id,
        String(a.attempt),
        stateColor(a.state),
        a.worker_id ?? '',
        a.ended_at ? `${new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()} ms` : '',
        a.error ? `[${a.error.class}] ${String(a.error.message).slice(0, 80)}` : '',
      ]),
    ]);
  }
  if (d.approvals?.length) {
    console.log(`\n${bold('Approvals')}`);
    for (const a of d.approvals) {
      const state = a.decision ? `${stateColor(a.decision)} by ${a.decided_by}` : `waiting for ${a.request.role} until ${a.request.expires_at}`;
      console.log(`${a.node_id}  ${state}`);
      if (!a.decision) {
        if (a.request.message) console.log(`    ${typeof a.request.message === 'string' ? a.request.message : JSON.stringify(a.request.message)}`);
        if (a.request.payload !== null) console.log(dim(`    payload ${JSON.stringify(a.request.payload)}`));
        console.log(dim(`    azhi approve ${r.id} ${a.node_id}   (or --reject)`));
      }
    }
  }
  if (d.actions.length) {
    console.log(`\n${bold('Action ledger')}`);
    for (const a of d.actions) {
      console.log(`${a.id}  ${a.tool}  ${a.effect}  ${stateColor(a.state)}  ${JSON.stringify(a.target)}`);
      for (const t of a.transitions) console.log(dim(`    ${new Date(t.at).toISOString()}  ${t.state.padEnd(16)} attempt ${t.fence}${t.note ? `  ${t.note}` : ''}`));
    }
  }
}
