// Converts the Starlight pages in src/content/docs into GitHub Wiki Markdown.
// Usage: node scripts/build-wiki.mjs [outDir]   (default: wiki-dist)
// Wiki page names are the slug with "/" replaced by "-"; the site index becomes Home.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const quote = (label, title, text) =>
  `> **${title || label}**\n>\n` + text.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');

function convertBody(body) {
  let t = body.replace(/^import .*$/gm, '');
  // Starlight :::note / :::tip / :::caution blocks
  t = t.replace(/^:::(\w+)(?:\[([^\]]*)\])?\n([\s\S]*?)\n:::$/gm, (_, type, title, text) =>
    quote(type[0].toUpperCase() + type.slice(1), title, text));
  // <Aside type="x" title="y">...</Aside>
  t = t.replace(/<Aside([^>]*)>([\s\S]*?)<\/Aside>/g, (_, attrs, text) => {
    const type = attrs.match(/type="([^"]*)"/)?.[1] ?? 'note';
    const title = attrs.match(/title="([^"]*)"/)?.[1];
    return quote(type[0].toUpperCase() + type.slice(1), title, text);
  });
  // Tabs become one headed section per tab
  t = t.replace(/<TabItem label="([^"]*)">/g, '### $1\n').replace(/<\/?(Tabs|TabItem)>/g, '');
  // Cards become list items
  t = t.replace(/^[ \t]*<LinkCard title="([^"]*)" description="([^"]*)" href="([^"]*)"\s*\/>/gm,
    '- [$1]($3): $2');
  t = t.replace(/^[ \t]*<Card title="([^"]*)"[^>]*>([\s\S]*?)<\/Card>/gm,
    (_, title, text) => `- **${title}**: ${text.trim().replace(/\s*\n\s*/g, ' ')}`);
  t = t.replace(/<\/?(CardGrid|Steps)[^>]*>/g, '');
  // Status tags: <span class="tag tag-built">Built</span> -> **Built**
  t = t.replace(/<span class="tag[^"]*">([^<]*)<\/span>/g, '**$1**');
  t = rewriteLinks(t);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// Sidebar groups and labels come from astro.config.mjs so the wiki nav matches the site.
function sidebar() {
  const cfg = readFileSync(join(root, 'astro.config.mjs'), 'utf8');
  const out = ['**[Home](Home)**', ''];
  for (const g of cfg.matchAll(/label: '([^']+)',\s*items: \[([\s\S]*?)\n\s{10}\],/g)) {
    out.push(`**${g[1]}**`, '');
    for (const i of g[2].matchAll(/label: '([^']+)', slug: '([^']+)'/g)) {
      out.push(`- [${i[1]}](${pageName(i[2])})`);
    }
    out.push('');
  }
  return out.join('\n');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of walk(docsDir)) {
  const slug = slugOf(file);
  const { fm, body } = frontmatter(readFileSync(file, 'utf8'));
  const head = `# ${fm.title}\n\n${fm.description ? `${fm.description}\n\n` : ''}`;
  const src = relative(docsDir, file).replace(/\\/g, '/');
  const md = `${head}${convertBody(body)}\n\n---\n_Generated from \`site/src/content/docs/${src}\`. ` +
    'Edit the source in the repository; changes made in the wiki are overwritten._\n';
  writeFileSync(join(outDir, `${pageName(slug)}.md`), md);
}
writeFileSync(join(outDir, '_Sidebar.md'), sidebar());
console.log(`Wrote ${walk(docsDir).length} wiki pages to ${outDir}`);
