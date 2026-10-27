// Checks every internal link and #anchor in the built site. Usage: node scripts/check-links.mjs [dist] [base]
// `base` is the path the site is hosted under (for example /azhi-flow); it may also come from SITE_BASE.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const base = (process.argv[3] ?? process.env.SITE_BASE ?? '').replace(/\/+$/, '');

const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const pages = walk(dist).filter((p) => p.endsWith('.html'));
const pageUrl = (file) => {
  const rel = relative(dist, file).split(sep).join('/').replace(/index\.html$/, '');
  return `${base}/${rel}`;
};

const ids = new Map();
const links = [];
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  for (const m of html.matchAll(/<a [^>]*href="([^"]+)"/g)) links.push([file, m[1]]);
}

let bad = 0;
for (const [file, href] of links) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue; // external, mailto:, etc.
  const url = new URL(href, `http://x${pageUrl(file)}`);
  let path = decodeURIComponent(url.pathname);
  if (base && !(path === base || path.startsWith(`${base}/`))) {
    console.log(`OUTSIDE BASE  ${pageUrl(file)} -> ${href}`);
    bad++;
    continue;
  }
  path = path.slice(base.length) || '/';
  let target = join(dist, path);
  if (!/\.[a-z0-9]+$/i.test(path)) target = join(target, 'index.html');
  if (!existsSync(target)) {
    console.log(`MISSING       ${pageUrl(file)} -> ${href}`);
    bad++;
  } else if (url.hash && target.endsWith('.html') && !ids.get(target)?.has(url.hash.slice(1))) {
    console.log(`NO ANCHOR     ${pageUrl(file)} -> ${href}`);
    bad++;
  }
}
console.log(`${pages.length} pages, ${links.length} links, ${bad} problems`);
process.exit(bad ? 1 : 0);
