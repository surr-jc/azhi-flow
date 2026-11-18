/** Slack Block Kit layouts shared by notify steps and approval messages. */

const SECTION_LIMIT = 2900;
const MAX_SECTIONS = 8;

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Escapes the three characters Slack treats as control codes in mrkdwn. */
export const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Splits long text on line breaks into section-sized pieces, so no block exceeds Slack's 3000 character limit. */
function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > SECTION_LIMIT) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
    while (cur.length > SECTION_LIMIT) {
      out.push(cur.slice(0, SECTION_LIMIT));
      cur = cur.slice(SECTION_LIMIT);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const runLink = (baseUrl: string, runId: string) => `${baseUrl.replace(/\/$/, '')}/ui/runs/${encodeURIComponent(runId)}`;

/** The message of a notify step: a title, the text, and where it came from (workflow, step, run, time). */
export function notificationBlocks(a: { workflow: string; runId: string; nodeId: string; text: string; baseUrl: string; at?: Date }) {
  const link = runLink(a.baseUrl, a.runId);
  const body = chunks(a.text || '(empty message)').slice(0, MAX_SECTIONS);
  return [
    { type: 'header', text: { type: 'plain_text', text: clip(`Azhi Flow: ${a.workflow}`, 150) } },
    ...body.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Workflow*\n${escapeMrkdwn(a.workflow)}` },
        { type: 'mrkdwn', text: `*Step*\n\`${escapeMrkdwn(a.nodeId)}\`` },
        { type: 'mrkdwn', text: `*Run*\n<${link}|${escapeMrkdwn(clip(a.runId, 40))}>` },
        { type: 'mrkdwn', text: `*Sent*\n<!date^${Math.floor((a.at ?? new Date()).getTime() / 1000)}^{date_short_pretty} at {time}|${(a.at ?? new Date()).toISOString()}>` },
      ],
    },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open run' }, url: link }] },
  ];
}

const sectionBlocks = (text: string) => chunks(text || '(no reply)').slice(0, 20).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }));

/** Markdown from the model into Slack mrkdwn. Escapes control codes first, so model text can never ping @channel or form a link it did not write. */
export function toMrkdwn(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      // Odd parts are code: kept as they are, apart from the escaping.
      if (i % 2) return escapeMrkdwn(part);
      return escapeMrkdwn(part)
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ');
    })
    .join('');
}

/** The blocks of an assistant reply, split so none exceeds Slack's per-block text limit. */
export const replyBlocks = (md: string) => sectionBlocks(toMrkdwn(md));

/** The confirm card for an action the assistant proposed: title, detail, Confirm and Dismiss. `value` names the stored proposal, never the arguments. */
export function proposalBlocks(a: { id: string; title: string; detail?: string; danger?: boolean }) {
  const value = JSON.stringify({ proposal: a.id });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(clip(a.title, 200))}*${a.detail ? `
${escapeMrkdwn(clip(a.detail, 2000))}` : ''}` } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'azhi_assistant_confirm',
          value,
          text: { type: 'plain_text', text: 'Confirm' },
          style: a.danger ? 'danger' : 'primary',
          ...(a.danger ? { confirm: { title: { type: 'plain_text', text: 'Are you sure?' }, text: { type: 'mrkdwn', text: escapeMrkdwn(clip(a.title, 200)) }, confirm: { type: 'plain_text', text: 'Confirm' }, deny: { type: 'plain_text', text: 'Cancel' } } } : {}),
        },
        { type: 'button', action_id: 'azhi_assistant_dismiss', value, text: { type: 'plain_text', text: 'Dismiss' } },
      ],
    },
  ];
}

/** What replaces a card once it is decided. */
export const decidedCard = (title: string, status: string) => [{ type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(clip(title, 200))}*
${status}` } }];
