/**
 * Spike 5: Slack as write-dedupable.
 *
 * Post with the action ID in message metadata, then find it again by reading channel history.
 * With SLACK_BOT_TOKEN and SLACK_CHANNEL set it runs against real Slack; otherwise it runs against
 * the bundled fake Slack API and says so.
 *
 * Run: npx tsx spikes/05-slack-dedupe.ts
 */
import { startFakeSlack } from '../src/testing/fake-slack.js';
import { findByDedupeKey, postMessage } from '../src/gateway/tools/slack.js';

const real = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL);
const fake = real ? null : await startFakeSlack();
const cfg = real ? { token: process.env.SLACK_BOT_TOKEN! } : { token: 'xoxb-fake', apiUrl: fake!.url };
const channel = process.env.SLACK_CHANNEL ?? 'C-QUALITY';
const key = `act_spike_${Date.now()}`;
const since = Math.floor(Date.now() / 1000) - 60;

const lines: string[] = [`target: ${real ? 'real Slack' : 'fake Slack API (set SLACK_BOT_TOKEN and SLACK_CHANNEL for a real run)'}`];
let ok = true;
const before = await findByDedupeKey(cfg, { channel, dedupeKey: key, oldest: since });
ok &&= before === null;
lines.push(`${before === null ? 'PASS' : 'FAIL'}  key absent before posting`);
const posted = await postMessage(cfg, { channel, text: 'Azhi Flow dedupe spike', dedupeKey: key });
const after = await findByDedupeKey(cfg, { channel, dedupeKey: key, oldest: since });
ok &&= after?.ts === posted.ts;
lines.push(`${after?.ts === posted.ts ? 'PASS' : 'FAIL'}  key found in history after posting (ts ${posted.ts})`);
const other = await findByDedupeKey(cfg, { channel, dedupeKey: `${key}_other`, oldest: since });
ok &&= other === null;
lines.push(`${other === null ? 'PASS' : 'FAIL'}  a different key is not matched`);
console.log(lines.join('\n'));
await fake?.close();
process.exit(ok ? 0 : 1);
