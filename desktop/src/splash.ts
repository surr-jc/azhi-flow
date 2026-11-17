// The start-up page: the logo of web/src/brand.tsx with its trace loader (web/src/components/LogoTraceLoader.tsx),
// the current step, and a live feed of what the backend prints while it starts. Colours are the web UI's tokens.
const GLYPH = 'M16 13 V36 H39.5 C44.5 36 48.5 31.5 48.5 24.5 C48.5 17.5 44.5 13 39.5 13 C34.5 13 30.5 17.5 30.5 24.5 V45 C30.5 49.5 27.5 52 24 52 C20.5 52 18.5 49.8 18.5 47.5';

/** How many feed lines stay on the page. */
const FEED_LINES = 7;

const STYLE = [
  ':root{color-scheme:light dark;--bg:#f5f6f8;--ink:#13213b;--muted:#556072;--line:#d9dee6;--accent:#0e6f6a;--accent-ink:#ffffff}',
  '@media(prefers-color-scheme:dark){:root{--bg:#0e141b;--ink:#e6ecf3;--muted:#9aa7b8;--line:#243140;--accent:#3cc0b4;--accent-ink:#062421}}',
  'body{margin:0;height:100vh;display:grid;place-items:center;font:15px system-ui,sans-serif;background:var(--bg);color:var(--ink)}',
  'main{display:flex;flex-direction:column;align-items:center;gap:20px;width:min(560px,calc(100vw - 48px))}',
  '.logo{position:relative;width:96px;height:96px}.logo svg{position:relative;display:block}',
  // A ring that leaves the tile and fades, so the icon reads as working even at a glance.
  '.logo::before{content:"";position:absolute;inset:0;border-radius:22px;border:2px solid var(--accent);opacity:0;animation:ring 2.1s ease-out infinite}',
  '@keyframes ring{0%{transform:scale(1);opacity:.55}100%{transform:scale(1.45);opacity:0}}',
  '@keyframes trace{to{stroke-dashoffset:-1}}.t{animation:trace 1.4s linear infinite}',
  '@keyframes fade{50%{opacity:.35}}',
  'p{margin:0;color:var(--muted);text-align:center;overflow-wrap:anywhere}',
  `ol{list-style:none;margin:0;padding:10px 14px;box-sizing:border-box;width:100%;height:${FEED_LINES * 20 + 20}px;overflow:hidden;` +
    'display:flex;flex-direction:column;justify-content:flex-end;border:1px solid var(--line);border-radius:8px;' +
    'font:12px/20px ui-monospace,Consolas,Menlo,monospace;color:var(--muted)}',
  'li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:in .25s ease-out}li:last-child{color:var(--ink)}',
  '@keyframes in{from{opacity:0;transform:translateY(6px)}}',
  // Reduced motion: nothing travels; the trace segment fades in place instead.
  '@media(prefers-reduced-motion:reduce){.logo::before,li{animation:none}.t{animation:fade 2.4s ease-in-out infinite;stroke-dasharray:1 0}}',
].join('');

// `feed` is called from the main process (webContents.executeJavaScript) with one line of backend output.
// Lines are set as text, never as HTML.
const SCRIPT =
  `var f=document.getElementById("f");` +
  `function feed(t){var li=document.createElement("li");li.textContent=t;f.appendChild(li);` +
  `while(f.children.length>${FEED_LINES})f.removeChild(f.firstChild)}`;

export const SPLASH_HTML =
  `<!doctype html><meta charset="utf-8"><title>Azhi Flow</title><style>${STYLE}</style>` +
  '<main><div class="logo"><svg viewBox="0 0 64 64" width="96" height="96" role="img" aria-label="Azhi Flow">' +
  '<rect width="64" height="64" rx="15" fill="var(--accent)"/>' +
  `<path d="${GLYPH}" fill="none" stroke="var(--accent-ink)" stroke-opacity=".3" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path class="t" d="${GLYPH}" fill="none" stroke="var(--accent-ink)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="0.16 0.84"/>` +
  '</svg></div><p id="s" role="status">Starting the local server&hellip;</p>' +
  `<ol id="f" aria-label="Start-up log"></ol></main><script>${SCRIPT}</script>`;

export const SPLASH_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML);

/** One line of backend output as the feed shows it: no colour codes, no `[azhi]` prefix, bounded length. */
export function feedLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/^\[azhi\]\s*/, '').trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
