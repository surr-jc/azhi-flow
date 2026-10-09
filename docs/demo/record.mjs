// Records the Azhi Flow demo video: the real web app (built into src/web/dist) driven by a script,
// answering from the sample data in mock.mjs, with captions and title cards drawn over the page.
//
//   npm run build:web
//   node docs/demo/record.mjs            # all scenes -> docs/demo/out/azhi-flow-demo.mp4
//   node docs/demo/record.mjs web guard  # only the named scenes (for trying one out)
//
// Needs Playwright with Chromium, and ffmpeg. PLAYWRIGHT_PKG may point at the playwright package.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve, mockApi } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const pkg = process.env.PLAYWRIGHT_PKG ?? 'playwright';
const { chromium } = await import(pkg.startsWith('/') ? pathToFileURL(path.join(pkg, 'index.mjs')).href : pkg);
const only = process.argv.slice(2);
const W = 1920, H = 1080, PORT = 4396;

// ---- overlay: captions, title cards, cursor, rings. Injected into every page ------------------
const overlay = () => {
  const css = `
  #__d *{box-sizing:border-box}
  #__cap{position:fixed;left:50%;bottom:34px;transform:translate(-50%,16px);z-index:99998;max-width:1400px;padding:18px 34px;border-radius:999px;background:rgba(12,18,27,.94);color:#fff;font:600 30px/1.3 system-ui,"Segoe UI",sans-serif;letter-spacing:-.01em;text-align:center;opacity:0;transition:opacity .35s,transform .35s;box-shadow:0 10px 40px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12)}
  #__cap.on{opacity:1;transform:translate(-50%,0)} #__cap b{color:#5eead4}
  #__tag{position:fixed;left:104px;top:20px;z-index:99998;padding:8px 18px;border-radius:999px;background:#0e6f6a;color:#fff;font:700 18px system-ui,sans-serif;letter-spacing:.02em;opacity:0;transition:opacity .3s}
  #__tag.on{opacity:1}
  #__card{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:radial-gradient(1200px 700px at 20% 10%,#12303a,#0b1118 60%);color:#fff;font-family:system-ui,"Segoe UI",sans-serif;opacity:0;pointer-events:none;transition:opacity .5s}
  #__card.on{opacity:1}
  #__card .in{max-width:1500px;padding:0 80px;text-align:center}
  #__card h1{font:800 104px/1.05 system-ui,sans-serif;margin:0 0 26px;letter-spacing:-.03em}
  #__card h2{font:700 70px/1.15 system-ui,sans-serif;margin:0;letter-spacing:-.02em}
  #__card p{font:500 36px/1.4 system-ui,sans-serif;color:#b6c3d4;margin:0}
  #__card .logo{width:120px;height:120px;border-radius:32px;background:#2fb7aa;color:#06231f;display:grid;place-items:center;font:800 62px system-ui;margin:0 auto 34px;letter-spacing:-.05em}
  #__card .bad{color:#ff8c80} #__card .ok{color:#5eead4}
  #__card ul{list-style:none;margin:0;padding:0;text-align:left;display:grid;gap:22px;font:600 40px/1.3 system-ui}
  #__card li::before{content:"\\2713";color:#5eead4;margin-right:20px;font-weight:800}
  #__card .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;text-align:left;margin-top:44px}
  #__card .tile{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:26px;padding:28px 30px}
  #__card .tile b{display:block;font:700 34px system-ui;color:#5eead4;margin-bottom:8px}
  #__card .tile span{font:500 25px/1.35 system-ui;color:#cdd8e6}
  #__card code{font:600 38px ui-monospace,Menlo,monospace;background:rgba(255,255,255,.1);padding:10px 20px;border-radius:14px;color:#5eead4}
  #__card .note{margin-top:30px;font:500 24px system-ui;color:#8798ad}
  #__cur{position:fixed;z-index:100000;left:0;top:0;width:34px;height:34px;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 3px 5px rgba(0,0,0,.4))}
  #__rip{position:fixed;z-index:100000;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:4px solid #14b8a6;pointer-events:none;animation:__rip .6s ease-out forwards}
  @keyframes __rip{to{transform:scale(3.6);opacity:0}}
  .__ring{position:fixed;z-index:99990;border-radius:28px;border:5px solid #f59e0b;box-shadow:0 0 0 6px rgba(245,158,11,.22);pointer-events:none;animation:__pulse 1.2s ease-in-out infinite}
  .__ring.teal{border-color:#14b8a6;box-shadow:0 0 0 6px rgba(20,184,166,.22)}
  @keyframes __pulse{50%{box-shadow:0 0 0 14px rgba(245,158,11,.08)}}`;
  const boot = () => {
    if (document.getElementById('__d')) return;
    const d = document.createElement('div'); d.id = '__d';
    d.innerHTML = `<style>${css}</style><div id="__tag"></div><div id="__cap"></div><div id="__card"><div class="in"></div></div>
      <svg id="__cur" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(d);
    addEventListener('mousemove', (e) => { document.getElementById('__cur').style.transform = `translate(${e.clientX - 6}px,${e.clientY - 3}px)`; }, true);
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.id = '__rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
  };
  const $ = (id) => document.getElementById(id);
  window.__demo = {
    caption(html) { const c = $('__cap'); if (!html) return c.classList.remove('on'); c.innerHTML = html; c.classList.add('on'); },
    tag(t) { const c = $('__tag'); if (!t) return c.classList.remove('on'); c.textContent = t; c.classList.add('on'); },
    card(html) { const c = $('__card'); if (!html) return c.classList.remove('on'); c.querySelector('.in').innerHTML = html; c.classList.add('on'); },
    rings(boxes, cls = '') { document.querySelectorAll('.__ring').forEach((r) => r.remove()); for (const b of boxes) { const r = document.createElement('div'); r.className = `__ring ${cls}`; Object.assign(r.style, { left: b.x - 8 + 'px', top: b.y - 8 + 'px', width: b.w + 16 + 'px', height: b.h + 16 + 'px' }); document.documentElement.appendChild(r); } },
  };
  if (document.documentElement) boot(); else addEventListener('DOMContentLoaded', boot);
  addEventListener('DOMContentLoaded', boot);
};

// ---- helpers -----------------------------------------------------------------------------------
const log = [];
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
const caption = async (html, plain) => { await page.evaluate((h) => window.__demo.caption(h), html); if (html) log.push({ at: now(), text: plain ?? html.replace(/<[^>]+>/g, '') }); };
const tag = (t) => page.evaluate((x) => window.__demo.tag(x), t);
const card = async (html, ms, plain) => { await page.evaluate((h) => window.__demo.card(h), html); if (plain) log.push({ at: now(), text: plain }); await sleep(ms); await page.evaluate(() => window.__demo.card('')); await sleep(550); };
const box = async (loc) => { const b = await loc.boundingBox(); if (!b) throw new Error('no box'); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const rings = async (locs, cls) => page.evaluate(([b, c]) => window.__demo.rings(b, c), [await Promise.all(locs.map(box)), cls]);
const unring = () => page.evaluate(() => window.__demo.rings([]));
async function glide(loc) { const b = await box(loc); await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 28 }); await sleep(200); return b; }
async function click(loc) { await glide(loc); await loc.click(); await sleep(350); }
async function hover(loc, ms = 900) { await glide(loc); await sleep(ms); }
const card_ = {
  logo: '<div class="logo">az</div>',
};

// ---- scenes ------------------------------------------------------------------------------------
const scenes = {
  async intro() {
    await card(`${card_.logo}<h1>Azhi Flow</h1><p>Governed, durable agent workflows that say plainly<br>what they can and cannot guarantee.</p>`, 5200, 'Azhi Flow: governed, durable agent workflows that say plainly what they can and cannot guarantee.');
    await card('<h2>Agents die halfway.</h2>', 2300, 'Agents die halfway.');
    await card('<h2>Retries <span class="bad">post twice</span>.</h2>', 2300, 'Retries post twice.');
    await card('<h2>Nobody can say what it <span class="bad">cost</span>,<br>or what it was allowed to do.</h2>', 3300, 'Nobody can say what it cost, or what it was allowed to do.');
    await card('<h2>Azhi starts from the <span class="ok">workflow</span>,<br>not the agent.</h2>', 3600, 'Azhi starts from the workflow, not the agent.');
  },

  async today() {
    await tag('1 · Mission Control');
    await page.mouse.move(900, 400);
    await caption('One screen for what is <b>running</b>, what <b>needs you</b>, and what it <b>cost</b>', 'One screen for what is running, what needs you, and what it cost.');
    await sleep(2200);
    await hover(page.locator('.stat, .stat-card, [class*="stat"]').nth(6), 1100).catch(() => sleep(1000));
    await caption('Spend is measured, never guessed: <b>$3.42 today</b>', 'Spend is measured, never guessed.');
    await sleep(1600);
    await hover(page.getByText('Approve the diff for PAY-1182').first(), 1400);
    await caption('Risky steps wait for a <b>person</b>', 'Risky steps wait for a person.');
    await sleep(1800);
    await caption('');
  },

  async workflow() {
    await tag('2 · Workflow-first');
    await click(page.getByRole('link', { name: 'Workflows' }).first());
    await sleep(700);
    await click(page.getByRole('link', { name: 'Pull request review (OpenCode)' }));
    await page.waitForSelector('.wf-card');
    await sleep(1400);
    await caption('A workflow of <b>nodes</b>. An agent is just one kind.', 'A workflow of nodes. An agent is just one kind.');
    await sleep(2600);
    const agents = page.locator('.wf-card.t-agent');
    await rings(await agents.all(), '');
    await caption('Only these <b>5 steps call a model</b>', 'Only these five steps call a model.');
    await sleep(3400);
    const code = page.locator('.wf-card.t-tool, .wf-card.t-report, .wf-card.t-condition, .wf-card.t-notify');
    await rings(await code.all(), 'teal');
    await caption('Fetch, route, report, post: <b>plain code, zero tokens</b>', 'Fetch, route, report and post are plain code: zero tokens.');
    await sleep(4000);
    await unring();
    await click(page.locator('.wf-card', { hasText: 'security' }).first());
    await caption('Select a step: its prompt, tools, budget and limits, in plain words', 'Select a step to read what it does and every setting.');
    await sleep(3600);
    await caption('');
  },

  async editor() {
    await tag('3 · Build the harness');
    await click(page.getByRole('link', { name: 'Edit this workflow' }));
    await page.waitForSelector('.ed-panel');
    await sleep(900);
    await caption('Edit on the canvas. The server <b>compiles and plans</b> every change.', 'Edit on the canvas. The server compiles and plans every change.');
    await sleep(2800);
    // 1. the harness of an agent step: scroll its settings
    await click(page.locator('.wf-card', { hasText: 'security' }).first());
    await caption('Per-agent harness: <b>executor, prompt, skills, read-only tools, MCP, budget</b>', 'Per-agent harness: executor, prompt, skills, read-only tools, MCP server and budget.');
    await sleep(1800);
    const side = page.locator('.ed-side');
    for (let i = 0; i < 5; i++) { await side.evaluate((el) => el.scrollBy({ top: 420, behavior: 'smooth' })); await sleep(1100); }
    await side.evaluate((el) => el.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(900);
    // 2. add a write step after the condition
    await click(page.locator('.wf-card', { hasText: 'should_post' }).first());
    await click(page.getByRole('tab', { name: 'Steps' }));
    await caption('Add a step from the palette: <b>tools come from the catalog</b>', 'Add a step from the palette. Tools come from the catalog.');
    await click(page.getByLabel('Search steps and tools'));
    await page.getByLabel('Search steps and tools').pressSequentially('comment', { delay: 110 });
    await sleep(900);
    await click(page.getByRole('button', { name: /Add a step that calls github.comment-on-pr/ }));
    await sleep(1500);
    await page.locator('.ed-check-float').waitFor();
    await rings([page.locator('.ed-check-float')], '');
    await caption('<b>Taint rule:</b> a write after an agent that read untrusted code <b>won’t compile</b> without a guard', 'Taint rule: a write after an agent that read untrusted code will not compile without a guard.');
    await sleep(4800);
    await unring();
    // 3. fix it
    const guard = page.getByLabel('Guard (CEL)').first();
    await guard.scrollIntoViewIfNeeded();
    await click(guard);
    await guard.pressSequentially('args.repo == inputs.repo && args.number == inputs.pr', { delay: 45 });
    await sleep(1800);
    await rings([page.locator('.ed-check-float')], 'teal');
    await caption('Pin the write to the reviewed PR: <b>compiles, no blockers</b>', 'Pin the write to the reviewed pull request. It compiles with no blockers.');
    await sleep(3800);
    await unring();
    await caption('');
  },

  async run() {
    await tag('4 · Every run is evidence');
    await click(page.getByRole('link', { name: 'Runs' }).first());
    await sleep(900);
    await click(page.getByRole('link', { name: /pr-review/ }).nth(1).or(page.locator('a[href*="run_5d03ee19"]').first()));
    await page.waitForSelector('.wf-card');
    await sleep(1200);
    await caption('What it <b>saw</b>, what it was <b>allowed</b> to do, what it <b>did</b>, what it <b>cost</b>', 'What it saw, what it was allowed to do, what it did, and what it cost.');
    await sleep(2400);
    await click(page.getByRole('button', { name: 'Replay' }));
    await caption('Replay the run, step by step', 'Replay the run, step by step.');
    await sleep(7500);
    const tabs = page.locator('.atlas-tabs');
    await click(tabs.getByRole('tab', { name: /^Ledger/ }));
    await caption('<b>Action ledger:</b> every external write, with receipts. Exactly once, even after a crash.', 'Action ledger: every external write with receipts. Exactly once, even after a crash.');
    await sleep(4600);
    await click(tabs.getByRole('tab', { name: /^Policy/ }));
    await caption('<b>Policy coverage:</b> what Azhi enforces itself, and what it only trusts the harness for', 'Policy coverage: what Azhi enforces itself, and what it only trusts the harness for.');
    await sleep(4600);
    await click(tabs.getByRole('tab', { name: /^Context/ }));
    await caption('<b>Context manifest:</b> every source the model saw, with hashes. Untrusted data is flagged.', 'Context manifest: every source the model saw, with hashes. Untrusted data is flagged.');
    await sleep(4600);
    await click(tabs.getByRole('tab', { name: /^Cost/ }));
    await caption('<b>Cost per step:</b> 9 model calls, $0.31, usage known for 100%', 'Cost per step: nine model calls, thirty-one cents, usage known for one hundred percent.');
    await sleep(4200);
    await caption('');
  },

  async approvals() {
    await tag('5 · Human in the loop');
    await click(page.getByRole('link', { name: 'Approvals' }).first());
    await sleep(900);
    await caption('Approvals carry the <b>payload</b> and who may decide. The decision is kept in the ledger.', 'Approvals carry the payload and who may decide. The decision is kept in the ledger.');
    await sleep(3200);
    await click(page.getByRole('button', { name: 'Approve' }).first());
    await sleep(1800);
    await caption('');
  },

  async usage() {
    await tag('6 · Tokens and cost');
    await click(page.getByRole('link', { name: 'Governance' }));
    await sleep(1200);
    await caption('Spend per day and per workflow: <b>tokens in, tokens out, dollars</b>', 'Spend per day and per workflow: tokens in, tokens out and dollars.');
    await sleep(3600);
    await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'smooth' }));
    await sleep(1200);
    await caption('<b>Spend limits</b> per workflow, per day or month. At the limit, new runs are refused.', 'Spend limits per workflow, per day or month. At the limit new runs are refused.');
    await sleep(4400);
    await caption('Unpriced turns show as <b>unknown</b>, never as zero', 'Unpriced turns show as unknown, never as zero.');
    await sleep(3000);
    await caption('');
  },

  async tokens() {
    await tag('');
    await card(`<h2 style="margin-bottom:46px">How Azhi <span class="ok">saves tokens</span></h2>
      <ul><li>Steps that need no model <b>never call one</b>: scripts, tools, conditions, reports</li>
      <li>Tool output is <b>projected</b>: agents get the fields they need, not whole payloads</li>
      <li><code style="font-size:30px">retrieve</code> returns <b>top_k</b> cited passages, not a corpus</li>
      <li>Per-step <b>budgets</b>: tool calls, output tokens, dollars</li>
      <li>Heavy harness and checkout only <b>where a step needs one</b></li>
      <li>Prompt caching, with cache tokens counted</li></ul>
      <p class="note">Mechanisms, not benchmarks. Savings depend on your workflow; Azhi measures yours.</p>`, 11500, 'How Azhi saves tokens: no model for steps that do not need one, projected tool output, top_k retrieval, per-step budgets, heavy harness only where needed, and prompt caching.');
  },

  async unique() {
    await card(`<h2>What Azhi does that agent runners don’t</h2>
      <div class="grid">
      <div class="tile"><b>Run plan</b><span>Every requirement marked native, bridged or unsupported. Blockers refuse the run before anything executes.</span></div>
      <div class="tile"><b>Taint gate</b><span>An ungated write after untrusted input fails to compile.</span></div>
      <div class="tile"><b>Exactly-once writes</b><span>Action ledger with fencing. Kill it mid-post: one Slack message.</span></div>
      <div class="tile"><b>Context manifest</b><span>What the model saw, per turn, with what is unobservable said out loud.</span></div>
      <div class="tile"><b>Durable by default</b><span>Temporal-backed runs: retries by error class, waits, schedules.</span></div>
      <div class="tile"><b>Bring your harness</b><span>Built-in agent, OpenCode or Claude Agent SDK. Signed packages, trust policies.</span></div>
      </div>`, 13000, 'What Azhi does that agent runners do not: run plan, taint gate, exactly-once writes, context manifest, durable runs, and your choice of harness with signed packages.');
  },

  async outro() {
    await card(`${card_.logo}<h2>Try it</h2><p style="margin:30px 0 34px"><code>azhi init</code> &nbsp; <code>azhi up</code></p><p>Self-hosted. Open source. github.com/surr-jc/azhi-flow</p>`, 6500, 'Try it: azhi init, azhi up. Self-hosted. github.com/surr-jc/azhi-flow');
  },
};

// ---- run ---------------------------------------------------------------------------------------
fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const srv = await serve(PORT);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'light', recordVideo: { dir: path.join(out, 'raw'), size: { width: W, height: H } } });
await ctx.addInitScript(overlay);
await mockApi(ctx);
page = await ctx.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message.slice(0, 200)));
t0 = Date.now();
await page.goto(`http://localhost:${PORT}/ui`);
await page.waitForSelector('.rail');
const order = ['intro', 'today', 'workflow', 'editor', 'run', 'approvals', 'usage', 'tokens', 'unique', 'outro'];
for (const name of order) {
  if (only.length && !only.includes(name)) continue;
  console.log(`scene ${name} @ ${now().toFixed(1)}s`);
  await scenes[name]();
  await tag('');
}
const total = now();
const video = page.video();
await ctx.close();
const raw = await video.path();
await browser.close();
srv.close();

fs.mkdirSync(out, { recursive: true });
const mp4 = path.join(out, 'azhi-flow-demo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', mp4]);

// Captions as SRT and as a narration script, for dubbing or translation.
const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const srt = log.map((l, i) => `${i + 1}\n${ts(l.at)} --> ${ts(Math.min(log[i + 1]?.at ?? total, l.at + 6))}\n${l.text}\n`).join('\n');
fs.writeFileSync(path.join(out, 'azhi-flow-demo.srt'), srt);
fs.writeFileSync(path.join(out, 'narration.md'), `# Azhi Flow demo: narration script\n\nTimestamps are seconds into the video.\n\n${log.map((l) => `- **${l.at.toFixed(0)}s**: ${l.text}`).join('\n')}\n`);
console.log(`done: ${mp4} (${total.toFixed(0)}s)`);
