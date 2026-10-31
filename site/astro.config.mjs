// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBase from './rehype-base.mjs';

// Set SITE_URL / SITE_BASE when hosting under a path (for example GitHub Pages: /azhi-flow).
const site = process.env.SITE_URL;
const base = process.env.SITE_BASE;

export default defineConfig({
  ...(site ? { site } : {}),
  ...(base ? { base } : {}),
  markdown: { rehypePlugins: [[rehypeBase, { base }]] },
  integrations: [
    starlight({
      title: 'Azhi Flow',
      description:
        'Governed, durable agent workflows that say plainly what they can and cannot guarantee.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'Azhi Flow',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      head: [
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'Azhi Flow' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
        ...(site
          ? [
              { tag: 'meta', attrs: { property: 'og:image', content: `${site}${base ?? ''}/og.png` } },
              { tag: 'meta', attrs: { name: 'twitter:image', content: `${site}${base ?? ''}/og.png` } },
            ]
          : []),
        {
          tag: 'meta',
          attrs: {
            name: 'keywords',
            content:
              'AI agent workflows, agent orchestration, Temporal, MCP, OpenCode, human-in-the-loop approvals, self-hosted, AI SDLC',
          },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareSourceCode',
            name: 'Azhi Flow',
            description:
              'Self-hosted, governed, durable AI agent workflow platform built on Temporal, with MCP tools, approvals and an action ledger.',
            codeRepository: 'https://github.com/surr-jc/azhi-flow',
            programmingLanguage: 'TypeScript',
            license: 'https://www.apache.org/licenses/LICENSE-2.0',
          }),
        },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/surr-jc/azhi-flow' }],
      editLink: { baseUrl: 'https://github.com/surr-jc/azhi-flow/edit/dev/site/' },
      lastUpdated: true,
      customCss: ['./src/styles/brand.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is Azhi Flow?', slug: 'overview' },
            { label: 'What is different', slug: 'unique' },
            { label: 'How it compares', slug: 'compare' },
            { label: 'Project status', slug: 'status' },
          ],
        },
        {
          label: 'Setup guides',
          items: [
            { label: 'Choose an install', slug: 'install' },
            { label: 'Linux', slug: 'install/linux' },
            { label: 'macOS', slug: 'install/macos' },
            { label: 'Windows', slug: 'install/windows' },
            { label: 'Local mode (no Docker)', slug: 'install/local-mode' },
            { label: 'Workers and OpenCode tools', slug: 'install/workers' },
            { label: 'First run', slug: 'install/first-run' },
            { label: 'Troubleshooting', slug: 'install/troubleshooting' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Workflow-first design', slug: 'concepts/workflow-first' },
            { label: 'Architecture', slug: 'concepts/architecture' },
            { label: 'Node types', slug: 'concepts/nodes' },
            { label: 'The run plan', slug: 'concepts/run-plan' },
            { label: 'The taint rule', slug: 'concepts/taint' },
            { label: 'Action ledger', slug: 'concepts/ledger' },
            { label: 'Context manifest', slug: 'concepts/context-manifest' },
            { label: 'Executors', slug: 'concepts/executors' },
            { label: 'Security and trust', slug: 'concepts/security' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'All features', slug: 'features' },
            { label: 'Mission Control', slug: 'features/mission-control' },
            { label: 'Build with chat', slug: 'features/builder' },
            { label: 'Cost and token control', slug: 'features/cost' },
            { label: 'Knowledge and citations', slug: 'features/knowledge' },
            { label: 'Approvals', slug: 'features/approvals' },
            { label: 'MCP and the library', slug: 'features/mcp-library' },
            { label: 'Result confidence', slug: 'features/confidence' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Write a workflow', slug: 'guides/write-a-workflow' },
            { label: 'Choose providers and models', slug: 'guides/models' },
            { label: 'Use a subscription, not API keys', slug: 'guides/subscriptions' },
          ],
        },
        {
          label: 'Examples',
          items: [
            { label: 'Example workflows', slug: 'examples' },
            { label: 'AI-SDLC v2: issue to PR', slug: 'examples/ai-sdlc-v2' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', slug: 'reference/cli' },
            { label: 'Environment variables', slug: 'reference/environment' },
            { label: 'Glossary', slug: 'reference/glossary' },
            { label: 'FAQ', slug: 'reference/faq' },
            { label: 'Host this site', slug: 'reference/hosting' },
          ],
        },
      ],
    }),
  ],
});
