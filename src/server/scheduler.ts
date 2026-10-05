import { CronExpressionParser } from 'cron-parser';
import { audit } from './catalog.js';
import { transaction } from '../db/pool.js';
import { createRun } from './runs.js';
import type { AppContext } from './context.js';
import { resolveVersion } from './workflows.js';

/**
 * Schedules (spec section 8): cron in an IANA timezone. Each occurrence has an ID
 * (`<schedule>@<occurrence time>`) that the runs table holds unique, so two servers or a restart
 * can never start the same occurrence twice. Daylight saving follows cron-parser: a local time
 * that does not exist (spring forward) fires at the next valid instant; a repeated local time
 * (fall back) fires once. After downtime only the most recent missed occurrence runs.
 */
export function startScheduler(ctx: AppContext, interpreterBuild: string, log: (m: string) => void = () => {}, intervalMs = 5000) {
  let stopped = false;
  const tick = () =>
    transaction(ctx.pool, async (c) => {
      const due = (
        await c.query(
          `SELECT s.id, s.workspace_id, s.cron, s.timezone, s.inputs, s.next_occurrence_at, w.slug FROM schedules s JOIN workflows w ON w.id = s.workflow_id
           WHERE s.enabled AND s.next_occurrence_at <= now() FOR UPDATE OF s SKIP LOCKED`,
        )
      ).rows;
      for (const s of due) {
        const now = new Date();
        // Find the latest occurrence at or before now (catch-up runs only the most recent one).
        const it = CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: new Date(s.next_occurrence_at.getTime() - 1) });
        let occurrence = it.next().toDate();
        for (;;) {
          const peek = CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: occurrence }).next().toDate();
          if (peek > now) break;
          occurrence = peek;
        }
        const next = CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: occurrence }).next().toDate();
        const version = await resolveVersion(ctx, s.workspace_id, `${s.slug}@latest`);
        if (version) {
          try {
            const r = await createRun(ctx, s.workspace_id, {
              version,
              inputs: s.inputs,
              trigger: 'schedule',
              createdBy: `schedule:${s.id}`,
              referenceTime: occurrence,
              occurrenceId: `${s.id}@${occurrence.toISOString()}`,
              interpreterBuild,
            });
            log(`schedule ${s.id}: occurrence ${occurrence.toISOString()} -> ${r.created ? 'started' : 'already started'} ${r.runId}`);
          } catch (err) {
            // An occurrence refused by a spend limit is skipped, not retried; the schedule moves on.
            // Anything else rolls the tick back and is retried, as before.
            if ((err as { details?: { blockers?: Array<{ code: string }> } }).details?.blockers?.[0]?.code !== 'budget_exceeded') throw err;
            log(`schedule ${s.id}: occurrence ${occurrence.toISOString()} refused: ${(err as Error).message}`);
            await audit(ctx, s.workspace_id, `schedule:${s.id}`, 'schedule.occurrence_refused', { schedule: s.id, workflow: s.slug, occurrence: occurrence.toISOString(), reason: (err as Error).message });
          }
        } else {
          log(`schedule ${s.id}: no published version of ${s.slug}`);
        }
        await c.query(`UPDATE schedules SET next_occurrence_at=$2 WHERE id=$1`, [s.id, next]);
      }
    }).catch((err) => log(`scheduler: ${(err as Error).message}`));
  const timer = setInterval(() => void (stopped || tick()), intervalMs);
  void tick();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
