# Azhi Flow documentation site

An [Astro Starlight](https://starlight.astro.build) site. It is a separate package: the root `npm ci`,
`npm run typecheck` and `npm run test:local` do not touch it.

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # static output in site/dist, with a Pagefind search index
npm run preview
```

Pages are MDX in `src/content/docs/`; the sidebar is in `astro.config.mjs`. Brand colours are in
`src/styles/brand.css` (from `docs/brand/README.md`).

To host under a path, such as GitHub Pages, set `SITE_URL` and `SITE_BASE` when building:

```bash
SITE_URL=https://surr-jc.github.io SITE_BASE=/azhi-flow npm run build
```

## Content rules

- Content comes from `README.md`, `docs/` and the code. Do not state a capability the code does not have.
- Label anything not fully shipped **Partly built** or **Vision** (`<span class="tag tag-partly">`).
- Unknowns stay unknown: no guessed numbers, costs or benchmarks.
- Dated comparisons carry their date. Re-check them before relying on a row.
- Astro 7 needs Node 22.22 or newer. The transitive `@astrojs/prism` asks for 22.23.4 and warns on older 22.x.
