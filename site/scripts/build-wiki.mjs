// Converts the Starlight pages in src/content/docs into GitHub Wiki Markdown.
// Usage: node scripts/build-wiki.mjs [outDir]   (default: wiki-dist)
// Wiki page names are the slug with "/" replaced by "-"; the site index becomes Home.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'src/content/docs');
const outDir = resolve(root, process.argv[2] ?? 'wiki-dist');

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.mdx') ? [p] : [];
  });

// "install/index.mdx" -> "install", "index.mdx" -> "" (site root)
const slugOf = (file) =>
  relative(docsDir, file).replace(/\\/g, '/').replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
const pageName = (slug) => (slug === '' ? 'Home' : slug.replace(/\//g, '-'));

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = line.match(/^(title|description):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  fm.actions = [...(m?.[1] ?? '').matchAll(/- text: (.*)\n\s+link: (\S+)/g)].map((a) => ({ text: a[1], link: a[2] }));
  return { fm, body: m ? src.slice(m[0].length) : src };
}

// Site-absolute links ("/concepts/taint/#x") become wiki page links ("concepts-taint#x").
function rewriteLinks(text) {
  return text.replace(/\]\((\/[^)\s]*)\)/g, (_, href) => {
    const [path, hash] = href.split('#');
    const slug = path.replace(/^\/|\/$/g, '');
    return `](${pageName(slug)}${hash ? `#${hash}` : ''})`;
  });
}

// GitHub renders > [!NOTE] style alerts with the same colours and icons Starlight uses for asides.
const ALERT = { note: 'NOTE', tip: 'TIP', caution: 'WARNING', danger: 'CAUTION' };
const quote = (type, title, text) =>
  [`> [!${ALERT[type] ?? 'NOTE'}]`, ...(title ? [`> **${title}**`, '>'] : []),
    ...text.trim().split('\n').map((l) => `> ${l}`.trimEnd())].join('\n');

// Starlight cards have no wiki equivalent; a two-column table is the closest layout.
const cell = (t) => t.replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|');
function cardTable(inner) {
  const cards = [...inner.matchAll(/<LinkCard title="([^"]*)" description="([^"]*)" href="([^"]*)"\s*\/>|<Card title="([^"]*)"[^>]*>([\s\S]*?)<\/Card>/g)]
    .map((c) => (c[1] ? `[**${c[1]}**](${c[3]})<br>${cell(c[2])}` : `**${c[4]}**<br>${cell(c[5])}`));
  const rows = ['| | |', '|---|---|'];
  for (let i = 0; i < cards.length; i += 2) rows.push(`| ${cards[i]} | ${cards[i + 1] ?? ''} |`);
  return `\n${rows.join('\n')}\n`;
}

function convertBody(body) {
  let t = body.replace(/^import .*$/gm, '');
  // Starlight :::note / :::tip / :::caution blocks
  t = t.replace(/^:::(\w+)(?:\[([^\]]*)\])?\n([\s\S]*?)\n:::$/gm, (_, type, title, text) =>
    quote(type, title, text));
  // <Aside type="x" title="y">...</Aside>
  t = t.replace(/<Aside([^>]*)>([\s\S]*?)<\/Aside>/g, (_, attrs, text) => {
    const type = attrs.match(/type="([^"]*)"/)?.[1] ?? 'note';
    const title = attrs.match(/title="([^"]*)"/)?.[1];
    return quote(type, title, text);
  });
  // Tabs become one headed section per tab
  t = t.replace(/<TabItem label="([^"]*)">/g, '### $1\n').replace(/<\/?(Tabs|TabItem)>/g, '');
  t = t.replace(/<CardGrid[^>]*>([\s\S]*?)<\/CardGrid>/g, (_, inner) => cardTable(inner));
  t = t.replace(/<\/?Steps[^>]*>/g, '');
  // Status tags keep the site's green / amber / grey meaning as coloured markers.
  const dot = { 'tag-built': '🟢', 'tag-partly': '🟠', 'tag-vision': '⚪' };
  t = t.replace(/<span class="tag (tag-[a-z]+)">([^<]*)<\/span>/g, (_, c, label) => `${dot[c] ?? ''} **${label}**`);
  t = rewriteLinks(t);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// Sidebar groups and labels come from astro.config.mjs so the wiki nav matches the site.
function sidebar() {
  const cfg = readFileSync(join(root, 'astro.config.mjs'), 'utf8');
  const out = [`<a href="Home">${logo(32)}</a>`, ''];
  for (const g of cfg.matchAll(/label: '([^']+)',\s*items: \[([\s\S]*?)\n\s{10}\],/g)) {
    out.push(`**${g[1]}**`, '');
    for (const i of g[2].matchAll(/label: '([^']+)', slug: '([^']+)'/g)) {
      out.push(`- [${i[1]}](${pageName(i[2])})`);
    }
    out.push('');
  }
  return out.join('\n');
}

// The logo files are the site's own; light/dark follow the viewer's GitHub theme.
const LOGO = 'images/logo-light.svg';
const logo = (h) => `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/logo-dark.svg">
  <img src="${LOGO}" alt="Azhi Flow" height="${h}">
</picture>`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'images'), { recursive: true });
for (const f of ['logo-light.svg', 'logo-dark.svg']) {
  copyFileSync(join(root, 'src/assets', f), join(outDir, 'images', f));
}

for (const file of walk(docsDir)) {
  const slug = slugOf(file);
  const { fm, body } = frontmatter(readFileSync(file, 'utf8'));
  const nav = fm.actions.map((a) => `<a href="${pageName(a.link.replace(/\/$/, ''))}"><b>${a.text}</b></a>`).join(' · ');
  const head = slug === ''
    ? `<p align="center">\n${logo(64)}\n</p>\n\n<h1 align="center">${fm.title}</h1>\n\n<p align="center">${fm.description}</p>\n\n<p align="center">${nav}</p>\n\n`
    : `# ${fm.title}\n\n${fm.description ? `_${fm.description}_\n\n` : ''}`;
  const src = relative(docsDir, file).replace(/\\/g, '/');
  const md = `${head}${convertBody(body)}\n\n---\n_Generated from \`site/src/content/docs/${src}\`. ` +
    'Edit the source in the repository; changes made in the wiki are overwritten._\n';
  writeFileSync(join(outDir, `${pageName(slug)}.md`), md);
}
writeFileSync(join(outDir, '_Sidebar.md'), sidebar());
console.log(`Wrote ${walk(docsDir).length} wiki pages to ${outDir}`);
