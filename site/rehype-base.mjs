// Astro does not prefix root-absolute links in Markdown/MDX with `base`. When the site is hosted under a
// path (GitHub Pages project sites), prefix them here so `/install/` becomes `/azhi-flow/install/`.
const isRootAbsolute = (v) => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//');

export default function rehypeBase({ base } = {}) {
  const prefix = (base ?? '').replace(/\/+$/, '');
  if (!prefix) return () => {};
  const fix = (v) => (isRootAbsolute(v) && !v.startsWith(prefix + '/') ? prefix + v : v);

  const visit = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && node.properties?.href) {
      node.properties.href = fix(node.properties.href);
    }
    // JSX components in MDX, such as <LinkCard href="/install/" />
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      for (const attr of node.attributes ?? []) {
        if (attr.name === 'href' && typeof attr.value === 'string') attr.value = fix(attr.value);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree) => visit(tree);
}
