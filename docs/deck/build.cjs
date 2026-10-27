// Builds docs/deck/azhi-flow.pptx. Screenshots come from capture.mjs (the real web app on sample data).
//   node docs/deck/build.cjs
const path = require('path');
const pptxgen = require('pptxgenjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const sharp = require('sharp');
const fi = require('react-icons/fi');
const { applyTheme } = require(process.env.APPLY_THEME ?? '/root/.claude/skills/synced/c5bb4901-12b9-448f-bbb1-384440500b37_a43ea602-f049-4c23-927b-da1b8088d349/pptx/scripts/apply_theme.js');

const here = __dirname;
const img = (n) => path.join(here, 'img', n + '.png');
const OUT = path.join(here, 'azhi-flow.pptx');

const THEME = {
  name: 'Azhi Flow', headFontFace: 'Cambria', bodyFontFace: 'Calibri',
  colors: { dk1: '0B1118', lt1: 'FFFFFF', dk2: '12303A', lt2: 'F1F4F7', accent1: '0E6F6A', accent2: '2FB7AA', accent3: 'D4900F', accent4: '5A3FB0', accent5: '2463A8', accent6: 'B42318', hlink: '0E6F6A', folHlink: '5A3FB0' },
};
const HEX = THEME.colors;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = 'Azhi Flow';
pres.author = 'Azhi Flow';
pres.subject = 'Governed, durable agent workflows';
const C = pres.SchemeColor;
const W = 13.33, H = 7.5, M = 0.6;

// ---- layouts ---------------------------------------------------------------------------------
pres.defineSlideMaster({
  title: 'DARK', background: { color: C.text1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.55, w: W - 2 * M, h: 1.0, fontFace: THEME.headFontFace, fontSize: 38, bold: true, color: C.background1, valign: 'top', align: 'left', margin: 0 }, text: '' } },
  ],
  slideNumber: { x: W - 1.0, y: H - 0.5, w: 0.5, h: 0.3, fontSize: 10, color: C.background2, align: 'right' },
});
pres.defineSlideMaster({
  title: 'COVER', background: { color: C.text1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 2.1, w: 6.2, h: 1.2, fontFace: THEME.headFontFace, fontSize: 60, bold: true, color: C.background1, valign: 'top', align: 'left', margin: 0 }, text: '' } },
  ],
});
pres.defineSlideMaster({
  title: 'CONTENT', background: { color: C.background1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.45, w: W - 2 * M, h: 0.9, fontFace: THEME.headFontFace, fontSize: 34, bold: true, color: C.text1, valign: 'top', align: 'left', margin: 0 }, text: '' } },
  ],
  slideNumber: { x: W - 1.0, y: H - 0.5, w: 0.5, h: 0.3, fontSize: 10, color: C.text2, align: 'right' },
});

// ---- helpers ---------------------------------------------------------------------------------
async function icon(name, color, size = 256) {
  const svg = renderToStaticMarkup(React.createElement(fi[name], { color: '#' + color, size: String(size) }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}
const shadow = () => ({ type: 'outer', color: '000000', opacity: 0.18, blur: 8, offset: 2, angle: 90 });
const text = (s, text_, o) => s.addText(text_, { isTextBox: true, margin: 0, fontFace: THEME.bodyFontFace, color: C.text1, valign: 'top', ...o });
const bullets = (items, o = {}) => items.map((t, i) => ({ text: t, options: { bullet: { indent: 16 }, breakLine: i < items.length - 1, paraSpaceAfter: 10, ...o } }));
async function iconCircle(s, name, x, y, d, bg, fg, objectName) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: bg }, line: { color: bg, width: 0 }, objectName: objectName + ' circle' });
  const p = d * 0.26;
  s.addImage({ data: await icon(name, fg), x: x + p, y: y + p, w: d - 2 * p, h: d - 2 * p, altText: name, objectName: objectName + ' icon' });
}
const picture = (s, file, x, y, w, ratio, name) => {
  s.addImage({ path: img(file), x, y, w, h: w * ratio, shadow: shadow(), altText: name, objectName: name });
};
const RATIO = 900 / 1600;

(async () => {
  // 1 ---- title
  pres.addSection({ title: 'Opening' });
  let s = pres.addSlide({ masterName: 'COVER', sectionTitle: 'Opening' });
  s.addShape(pres.ShapeType.roundRect, { x: M, y: 0.7, w: 0.9, h: 0.9, rectRadius: 0.22, fill: { color: C.accent2 }, line: { color: C.accent2, width: 0 }, objectName: 'Logo tile' });
  text(s, 'az', { x: M, y: 0.7, w: 0.9, h: 0.9, fontSize: 30, bold: true, color: C.text1, align: 'center', valign: 'middle', fontFace: THEME.headFontFace, objectName: 'Logo text' });
  s.addText('Azhi Flow', { placeholder: 'title' });
  text(s, 'Governed, durable agent workflows that say plainly what they can and cannot guarantee.', { x: M, y: 3.5, w: 5.6, h: 1.4, fontSize: 22, color: C.background2, objectName: 'Tagline' });
  text(s, 'Self-hosted  ·  Open source  ·  Apache-2.0', { x: M, y: 5.3, w: 5.8, h: 0.4, fontSize: 16, color: C.accent2, objectName: 'Facts' });
  text(s, 'https://github.com/comcast-enterprise/azhi-flow', { x: M, y: 5.8, w: 6.2, h: 0.4, fontSize: 14, color: C.background2, objectName: 'Repository' });
  picture(s, 'workflow', 6.95, 1.45, 5.8, RATIO, 'Workflow canvas screenshot');
  s.addNotes('Azhi Flow is a self-hosted runtime for AI workflows. The picture is the real web app, on sample data.');

  // 2 ---- problem
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'Opening' });
  s.addText('Agents in production fail in familiar ways', { placeholder: 'title' });
  const problems = [
    ['FiPower', 'Runs die halfway', 'A crash, restart or timeout, and the work is redone or lost.', C.accent6],
    ['FiCopy', 'Retries write twice', 'The retried agent posts to Slack or GitHub a second time.', C.accent3],
    ['FiEye', 'No one can say what happened', 'What did it see, what was it allowed to do, and what did it cost?', C.accent5],
    ['FiShield', 'Untrusted text steers writes', 'A pull request or ticket can talk an agent into a write it should never make.', C.accent4],
  ];
  const cw = 2.8, gap = 0.2;
  for (let i = 0; i < problems.length; i++) {
    const [ic, t, d, col] = problems[i];
    const x = M + i * (cw + gap);
    s.addShape(pres.ShapeType.roundRect, { x, y: 1.9, w: cw, h: 3.2, rectRadius: 0.18, fill: { color: C.background2 }, line: { color: C.background2, width: 0 }, objectName: `Problem card ${i + 1}` });
    await iconCircle(s, ic, x + 0.3, 2.2, 0.8, col, 'FFFFFF', `Problem ${i + 1}`);
    text(s, t, { x: x + 0.3, y: 3.25, w: cw - 0.6, h: 0.8, fontSize: 20, bold: true, objectName: `Problem ${i + 1} title` });
    text(s, d, { x: x + 0.3, y: 4.05, w: cw - 0.6, h: 1.0, fontSize: 14, color: C.text2, objectName: `Problem ${i + 1} text` });
  }
  s.addShape(pres.ShapeType.roundRect, { x: M, y: 5.5, w: W - 2 * M, h: 0.95, rectRadius: 0.18, fill: { color: C.text2 }, line: { color: C.text2, width: 0 }, objectName: 'Answer band' });
  text(s, [{ text: 'Azhi starts from the ', options: {} }, { text: 'workflow', options: { color: C.accent2, bold: true } }, { text: ', not the agent.', options: {} }], { x: M + 0.4, y: 5.5, w: W - 2 * M - 0.8, h: 0.95, fontSize: 24, color: C.background1, valign: 'middle', objectName: 'Answer text' });
  s.addNotes('Four failure modes. Azhi answers all four by treating the agent as one node in a durable, governed workflow.');

  // 3 ---- workflow-first
  pres.addSection({ title: 'How it works' });
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'How it works' });
  s.addText('A workflow of nodes, and an agent is just one of them', { placeholder: 'title' });
  const nodes = [['Script', C.accent5], ['Tool', C.accent5], ['Retrieve', C.accent4], ['Agent', C.accent4], ['Condition', C.accent3], ['Parallel', C.accent3], ['Loop', C.accent3], ['Subworkflow', C.accent3], ['Approval', C.accent6], ['Report', C.accent1], ['Notify', C.accent1]];
  nodes.forEach(([t, col], i) => {
    const cx = M + (i % 4) * 1.55, cy = 1.9 + Math.floor(i / 4) * 0.7;
    s.addShape(pres.ShapeType.roundRect, { x: cx, y: cy, w: 1.42, h: 0.52, rectRadius: 0.26, fill: { color: col }, line: { color: col, width: 0 }, objectName: `Node chip ${t}` });
    text(s, t, { x: cx, y: cy, w: 1.42, h: 0.52, fontSize: 14, bold: true, color: C.background1, align: 'center', valign: 'middle', objectName: `Node chip ${t} label` });
  });
  text(s, 'Eleven node types in one YAML definition (schema 2.0), checked by a compiler before anything runs.', { x: M, y: 4.2, w: 5.9, h: 0.8, fontSize: 16, objectName: 'Node note' });
  s.addText(bullets(['Steps that need no model run as plain code and cost no tokens', 'The agent step is bounded: budget, tools, output schema', 'Durable on Temporal: retries, waits, schedules, cancellation']), { isTextBox: true, x: M, y: 5.0, w: 5.9, h: 1.6, fontSize: 16, margin: 0, color: C.text1, valign: 'top', objectName: 'Workflow-first points' });
  picture(s, 'workflow', 7.0, 1.7, 5.75, RATIO, 'pr-review workflow screenshot');
  text(s, 'The pull request review workflow: 12 steps, 5 of them call a model.', { x: 7.0, y: 5.1, w: 5.75, h: 0.4, fontSize: 12, color: C.text2, objectName: 'Screenshot caption' });
  s.addNotes('pr-review: pr, four reviewer agents, summarize, report, slack_message, two conditions, post, notify. Five agent steps.');

  // 4 ---- tokens
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'How it works' });
  s.addText('A model is called only where judgment is needed', { placeholder: 'title' });
  s.addChart(pres.charts.DOUGHNUT, [{ name: 'Steps', labels: ['Call a model', 'Plain code and tools'], values: [5, 7] }], {
    x: M, y: 1.6, w: 4.6, h: 4.4, holeSize: 62, chartColors: [HEX.accent4, HEX.accent2], showLegend: true, legendPos: 'b', legendFontSize: 14, legendFontFace: '+mn-lt', legendColor: HEX.dk1,
    showPercent: false, showValue: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: 18, dataLabelFontBold: true, dataLabelFontFace: '+mn-lt', showTitle: false, dataBorder: { pt: 2, color: 'FFFFFF' },
  });
  text(s, '5 of 12', { x: M + 1.35, y: 3.1, w: 1.9, h: 0.6, fontSize: 28, bold: true, align: 'center', fontFace: THEME.headFontFace, objectName: 'Donut centre' });
  text(s, 'steps in the PR review', { x: M + 1.1, y: 3.65, w: 2.4, h: 0.3, fontSize: 12, color: C.text2, align: 'center', objectName: 'Donut centre caption' });
  const saves = ['Steps that need no model never call one', 'Tool output is projected: agents get the fields they need', 'retrieve returns top-k cited passages, not a corpus', 'Per-step budgets: tool calls, output tokens, dollars', 'Heavy harness and checkout only where a step needs one', 'Prompt caching, with cache tokens counted'];
  saves.forEach((t, i) => {
    const y = 1.65 + i * 0.72;
    s.addShape(pres.ShapeType.ellipse, { x: 5.9, y, w: 0.5, h: 0.5, fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }, objectName: `Saving ${i + 1} badge` });
    text(s, String(i + 1), { x: 5.9, y, w: 0.5, h: 0.5, fontSize: 16, bold: true, color: C.background1, align: 'center', valign: 'middle', objectName: `Saving ${i + 1} number` });
    text(s, t, { x: 6.6, y, w: 6.1, h: 0.5, fontSize: 18, valign: 'middle', objectName: `Saving ${i + 1} text` });
  });
  text(s, 'Mechanisms, not benchmarks. The count is from the example workflow; your savings depend on your workflow, and Azhi reports your measured cost.', { x: 5.9, y: 6.1, w: 6.8, h: 0.6, fontSize: 12, color: C.text2, objectName: 'Honesty note' });
  s.addNotes('No savings percentage is claimed. The 5 of 12 comes from the example pr-review workflow.');

  // 5 ---- mission control
  pres.addSection({ title: 'The product' });
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'The product' });
  s.addText('Mission Control: one screen for what needs you', { placeholder: 'title' });
  picture(s, 'today', M, 1.7, 8.0, RATIO, 'Mission Control screenshot');
  s.addText(bullets(['What is running, waiting and failing', 'Approvals waiting on a person, with the payload', 'Alerts, schedules and worker health', 'Model spend today and this week', 'Every action goes through the same API and role checks as the CLI']), { isTextBox: true, x: 8.95, y: 1.8, w: 3.8, h: 4.4, fontSize: 16, margin: 0, color: C.text1, valign: 'top', objectName: 'Mission Control points' });
  s.addNotes('Secrets are write-only in the UI. Unknown cost shows as unknown.');

  // 6 ---- harness
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'The product' });
  s.addText('Build the harness on the canvas, checked as you type', { placeholder: 'title' });
  picture(s, 'editor-taint', M, 1.7, 8.0, RATIO, 'Editor screenshot with the taint rule');
  s.addText(bullets(['Per-agent harness: executor, prompt, skills, read-only tools, MCP servers, budget', 'Add tools from the catalog; each new step runs after the selected one', 'The server compiles and plans every change', 'Taint rule: a write after an agent that read untrusted code fails to compile. A guard fixes it']), { isTextBox: true, x: 8.95, y: 1.8, w: 3.8, h: 4.6, fontSize: 16, margin: 0, color: C.text1, valign: 'top', objectName: 'Harness points' });
  s.addNotes('In the screenshot the new comment-on-pr step is flagged because it writes after agents that read untrusted pull request code.');

  // 7 ---- run evidence
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'The product' });
  s.addText('Every run is evidence, not a log to dig through', { placeholder: 'title' });
  picture(s, 'run', M, 1.7, 8.0, RATIO, 'Run page screenshot');
  const ev = [['FiList', 'Action ledger', 'Every external write, with receipts. Exactly once.', C.accent1], ['FiCheckSquare', 'Policy coverage', 'Enforced by Azhi, by the harness, or unobservable.', C.accent5], ['FiLayers', 'Context manifest', 'Every source the model saw, with hashes.', C.accent4], ['FiDollarSign', 'Cost per step', 'Usage per turn; unknown stays unknown.', C.accent3]];
  for (let i = 0; i < ev.length; i++) {
    const [ic, t, d, col] = ev[i]; const y = 1.75 + i * 1.2;
    await iconCircle(s, ic, 8.95, y, 0.7, col, 'FFFFFF', `Evidence ${t}`);
    text(s, t, { x: 9.85, y, w: 3.0, h: 0.35, fontSize: 18, bold: true, objectName: `Evidence ${t} title` });
    text(s, d, { x: 9.85, y: y + 0.38, w: 3.0, h: 0.7, fontSize: 14, color: C.text2, objectName: `Evidence ${t} text` });
  }
  s.addNotes('Replay scrubs through the run events. The ledger uses fencing so a crash mid-post still yields one message.');

  // 8 ---- trust
  pres.addSection({ title: 'Why it is different' });
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'Why it is different' });
  s.addText('Trust you can check before and after a run', { placeholder: 'title' });
  const trust = [
    ['FiClipboard', 'Run plan', 'Each requirement marked native, bridged, unsupported or unverified. Blockers refuse the run before anything executes.', C.accent1],
    ['FiLock', 'Taint gate', 'An ungated write after an agent that read untrusted data fails to compile.', C.accent6],
    ['FiRepeat', 'Exactly-once writes', 'Gateway and ledger with fencing. Kill it mid-post: one Slack message.', C.accent5],
    ['FiLayers', 'Context manifest', 'What the model saw on every turn, and what is unobservable said out loud.', C.accent4],
    ['FiKey', 'Signed packages', 'Per-publisher keys certified by the workspace; workers enforce a trust policy.', C.accent3],
    ['FiUserCheck', 'Human approvals', 'Gates on risky steps, decided in the web app or Slack, kept in the ledger.', C.accent2],
  ];
  const tw = 3.9, th = 2.35;
  for (let i = 0; i < trust.length; i++) {
    const [ic, t, d, col] = trust[i]; const x = M + (i % 3) * (tw + 0.17), y = 1.7 + Math.floor(i / 3) * (th + 0.2);
    s.addShape(pres.ShapeType.roundRect, { x, y, w: tw, h: th, rectRadius: 0.16, fill: { color: C.background2 }, line: { color: C.background2, width: 0 }, objectName: `Trust card ${t}` });
    await iconCircle(s, ic, x + 0.28, y + 0.28, 0.62, col, 'FFFFFF', `Trust ${t}`);
    text(s, t, { x: x + 1.05, y: y + 0.28, w: tw - 1.3, h: 0.62, fontSize: 20, bold: true, valign: 'middle', objectName: `Trust ${t} title` });
    text(s, d, { x: x + 0.28, y: y + 1.05, w: tw - 0.56, h: 1.2, fontSize: 14, color: C.text2, objectName: `Trust ${t} text` });
  }
  s.addNotes('Policy coverage labels each rule enforced, harness-enforced or unobservable, per executor.');

  // 9 ---- spend
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'Why it is different' });
  s.addText('Spend you can see, cap and trust', { placeholder: 'title' });
  picture(s, 'usage', M, 1.7, 8.0, RATIO, 'Usage and spend screenshot (sample data)');
  s.addText(bullets(['Tokens in, tokens out and dollars, per day and per workflow', 'Per-step budgets: max tool calls, output tokens and cost', 'Spend limits per workflow or workspace, per day or month. At the limit, new runs are refused', 'Alerts at 80% and 100%', 'Cost comes from declared pricing; unpriced turns show as unknown, never zero']), { isTextBox: true, x: 8.95, y: 1.8, w: 3.8, h: 4.8, fontSize: 16, margin: 0, color: C.text1, valign: 'top', objectName: 'Spend points' });
  text(s, 'Figures on the screenshot are sample data.', { x: M, y: 6.4, w: 8.0, h: 0.3, fontSize: 12, color: C.text2, objectName: 'Sample data note' });
  s.addNotes('Copilot steps are counted in AI credits against the monthly pool.');

  // 10 ---- comparison
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'Why it is different' });
  s.addText('Where Azhi fits next to the tools you already use', { placeholder: 'title' });
  const hd = (t, fill) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: fill }, align: 'center', valign: 'middle', fontSize: 14 } });
  const lab = (t) => ({ text: t, options: { bold: true, color: HEX.dk1, fontSize: 14, valign: 'middle' } });
  const yes = { text: 'Yes', options: { bold: true, color: HEX.accent1, align: 'center', valign: 'middle', fontSize: 14 } };
  const no = { text: 'No', options: { color: '6B7686', align: 'center', valign: 'middle', fontSize: 14 } };
  const part = (t) => ({ text: t, options: { color: HEX.accent3, align: 'center', valign: 'middle', fontSize: 13 } });
  const rows = [
    [hd('', HEX.dk2), hd('Azhi Flow', HEX.accent1), hd('OpenCode', HEX.dk2), hd('VS Code agent mode', HEX.dk2), hd('n8n-style', HEX.dk2), hd('LangGraph-style', HEX.dk2)],
    [lab('Durable runs, retries, schedules'), yes, no, no, yes, part('Checkpoints')],
    [lab('Plan of what is enforced, before the run'), yes, no, no, no, no],
    [lab('Exactly-once writes ledger'), yes, no, no, no, no],
    [lab('Compile-time taint check'), yes, no, no, no, no],
    [lab('Per-turn context manifest'), yes, no, no, no, no],
    [lab('Per-step budgets and spend limits'), yes, part('Usage shown'), part('Plan-level'), part('Varies'), part('Separate tools')],
    [lab('Human approval gates'), yes, part('Per tool'), part('Per tool'), yes, yes],
  ];
  s.addTable(rows, { x: M, y: 1.6, w: W - 2 * M, colW: [3.6, 1.6, 1.6, 1.9, 1.6, 1.83], rowH: 0.55, fontFace: THEME.bodyFontFace, border: { type: 'solid', color: 'D9DEE6', pt: 0.75 }, fill: { color: 'FFFFFF' }, margin: [0.04, 0.1, 0.04, 0.1], autoPage: false });
  text(s, 'As of 6 October 2026, from each product’s public descriptions; these tools change quickly. OpenCode and the Claude Agent SDK also run inside Azhi as executors.', { x: M, y: 6.15, w: W - 2 * M, h: 0.6, fontSize: 12, color: C.text2, objectName: 'Comparison source' });
  s.addNotes('Azhi is not a replacement for an in-editor assistant. Several of these tools can run inside Azhi.');

  // 11 ---- executors and examples
  pres.addSection({ title: 'Use it' });
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'Use it' });
  s.addText('Bring your harness. Start from a working example', { placeholder: 'title' });
  text(s, 'Pluggable executors', { x: M, y: 1.65, w: 5.6, h: 0.4, fontSize: 20, bold: true, objectName: 'Executors heading' });
  const ex = [['Built-in model agent', 'Anthropic or OpenAI, gateway-only tools, validated output'], ['OpenCode', 'Fresh repository checkout, skills, read-only tools, MCP; Anthropic or GitHub Copilot models'], ['Claude Agent SDK', 'Anthropic, with declared capabilities checked by the run plan']];
  ex.forEach(([t, d], i) => {
    const y = 2.2 + i * 1.35;
    s.addShape(pres.ShapeType.roundRect, { x: M, y, w: 5.9, h: 1.15, rectRadius: 0.14, fill: { color: C.background2 }, line: { color: C.background2, width: 0 }, objectName: `Executor card ${t}` });
    text(s, t, { x: M + 0.3, y: y + 0.12, w: 5.3, h: 0.4, fontSize: 18, bold: true, color: C.accent1, objectName: `Executor ${t} title` });
    text(s, d, { x: M + 0.3, y: y + 0.52, w: 5.3, h: 0.6, fontSize: 14, color: C.text2, objectName: `Executor ${t} text` });
  });
  text(s, 'Examples that ship with it', { x: 7.1, y: 1.65, w: 5.6, h: 0.4, fontSize: 20, bold: true, objectName: 'Examples heading' });
  const exs = [['Weekly quality report', 'CI metrics analysed by a model, posted to Slack with numbered citations.'], ['Pull request review', 'Parallel OpenCode reviewers in isolated checkouts; an approval gates the comment.'], ['Feature delivery', 'Jira or GitHub issue to requirements, design, build, tests and a reviewed pull request.'], ['Issue root cause', 'Investigator agent returns a 5-whys chain with file and line evidence.']];
  exs.forEach(([t, d], i) => {
    const y = 2.2 + i * 1.02;
    s.addShape(pres.ShapeType.roundRect, { x: 7.1, y, w: 5.63, h: 0.88, rectRadius: 0.14, fill: { color: C.background2 }, line: { color: C.background2, width: 0 }, objectName: `Example card ${t}` });
    text(s, t, { x: 7.35, y: y + 0.08, w: 5.2, h: 0.32, fontSize: 16, bold: true, objectName: `Example ${t} title` });
    text(s, d, { x: 7.35, y: y + 0.4, w: 5.2, h: 0.45, fontSize: 12, color: C.text2, objectName: `Example ${t} text` });
  });
  s.addNotes('Examples install with azhi example install, or from the marketplace page in Mission Control.');

  // 12 ---- status
  s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: 'Use it' });
  s.addText('Honest status: what is built, and what is vision', { placeholder: 'title' });
  const cols = [
    ['Built', C.accent1, ['Eleven node types, YAML schema 2.0, compiler', 'Durable runs on Temporal', 'Gateway, action ledger, run plan, taint gate', 'Model agent, OpenCode, Claude Agent SDK', 'Datasets with hybrid retrieval and citations', 'Mission Control, CLI and REST API']],
    ['Partly built', C.accent3, ['Provider choice per profile, not by capability', 'MCP over stdio; streamable HTTP pending', 'Token optimization by design, not automatic', 'Worker checkouts; no hosted sandbox yet']],
    ['Vision', C.accent4, ['Capability-based model routing', 'Result caching across runs', 'Savings reports against a baseline', 'Capability resolution, then a capability graph', 'Workflows exposed as MCP tools']],
  ];
  cols.forEach(([t, col, items], i) => {
    const x = M + i * 4.1;
    s.addShape(pres.ShapeType.roundRect, { x, y: 1.7, w: 3.9, h: 0.6, rectRadius: 0.3, fill: { color: col }, line: { color: col, width: 0 }, objectName: `Status ${t} header` });
    text(s, t, { x, y: 1.7, w: 3.9, h: 0.6, fontSize: 18, bold: true, color: C.background1, align: 'center', valign: 'middle', objectName: `Status ${t} label` });
    s.addText(bullets(items), { isTextBox: true, x: x + 0.1, y: 2.55, w: 3.7, h: 3.9, fontSize: 14, margin: 0, color: C.text1, valign: 'top', objectName: `Status ${t} items` });
  });
  text(s, 'Alpha, version 0.1.0. Server and workers on Linux (Windows through WSL2); local mode runs everything in one process.', { x: M, y: 6.5, w: W - 2 * M, h: 0.4, fontSize: 12, color: C.text2, objectName: 'Status footnote' });
  s.addNotes('Claim the roadmap only as each piece ships. Source: docs/positioning.md.');

  // 13 ---- close
  s = pres.addSlide({ masterName: 'DARK', sectionTitle: 'Use it' });
  s.addText('Try it', { placeholder: 'title' });
  s.addShape(pres.ShapeType.roundRect, { x: M, y: 1.9, w: 7.7, h: 2.2, rectRadius: 0.16, fill: { color: C.text2 }, line: { color: C.text2, width: 0 }, objectName: 'Code block' });
  s.addText([
    { text: 'git clone https://github.com/comcast-enterprise/azhi-flow', options: { breakLine: true } },
    { text: 'cd azhi-flow && npm ci', options: { breakLine: true } },
    { text: 'npx azhi up', options: { color: C.accent2, bold: true } },
  ], { isTextBox: true, x: M + 0.35, y: 2.1, w: 7.2, h: 1.8, fontFace: 'Courier New', fontSize: 14, color: C.background1, margin: 0, valign: 'middle', paraSpaceAfter: 8, objectName: 'Code text' });
  text(s, 'Prints the web link. Or run deploy/install.sh for the Docker stack with PostgreSQL, Temporal and the server.', { x: M, y: 4.35, w: 7.2, h: 0.7, fontSize: 16, color: C.background2, objectName: 'Install note' });
  text(s, 'Repository', { x: 8.75, y: 1.95, w: 4.0, h: 0.3, fontSize: 14, color: C.accent2, bold: true, objectName: 'Repo label' });
  text(s, 'github.com/comcast-enterprise/azhi-flow', { x: 8.75, y: 2.3, w: 4.4, h: 0.5, fontSize: 16, color: C.background1, objectName: 'Repo link', hyperlink: { url: 'https://github.com/comcast-enterprise/azhi-flow' } });
  text(s, 'Demo video', { x: 8.75, y: 3.2, w: 4.1, h: 0.3, fontSize: 14, color: C.accent2, bold: true, objectName: 'Video label' });
  text(s, 'docs/demo/out/azhi-flow-demo.mp4', { x: 8.75, y: 3.55, w: 4.2, h: 0.5, fontSize: 16, color: C.background1, objectName: 'Video path' });
  text(s, 'Documentation', { x: 8.75, y: 4.45, w: 4.1, h: 0.3, fontSize: 14, color: C.accent2, bold: true, objectName: 'Docs label' });
  text(s, 'README, docs/positioning.md, docs/install.md', { x: 8.75, y: 4.8, w: 4.2, h: 0.5, fontSize: 16, color: C.background1, objectName: 'Docs path' });
  text(s, 'Governed, durable agent workflows that say plainly what they can and cannot guarantee.', { x: M, y: 6.3, w: 9, h: 0.5, fontSize: 16, color: C.background2, objectName: 'Closing tagline' });
  s.addNotes('Alpha release. Linux workers; Windows through WSL2.');

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log('wrote', OUT);
})();
