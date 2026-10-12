import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ModelChoice } from '../web/src/components/ModelChoice.js';

describe('model availability picker', () => {
  it('preserves a saved filtered model as unavailable without changing it', () => {
    const client = new QueryClient();
    client.setQueryData(['model-options'], { providers: [{ id: 'anthropic', label: 'Anthropic', ready: true, enabled: true, credential: 'key', server_default_model: null, server_default_env: 'MODEL', executors: [] }] });
    client.setQueryData(['model-options', 'models', 'anthropic'], { models: [{ id: 'new-id', label: 'New' }], allowed_model_ids: ['new-id'], source: 'built-in' });
    let changed = false;
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ModelChoice, { value: { provider: 'anthropic', name: 'old-id' }, onChange: () => { changed = true; } })));
    expect(html).toContain('old-id (unavailable)');
    expect(html).toContain('Saved model old-id is unavailable');
    expect(html).not.toContain('Other model id');
    expect(changed).toBe(false);
    client.clear();
  });

  it('preserves a disabled provider as a nonselectable saved choice', () => {
    const client = new QueryClient();
    client.setQueryData(['model-options'], { providers: [{ id: 'openai', label: 'OpenAI', ready: true, enabled: false, credential: 'key', server_default_model: null, server_default_env: 'MODEL', executors: [] }] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ModelChoice, { value: { provider: 'openai', name: 'saved' }, onChange: () => {} })));
    expect(html).toContain('OpenAI (unavailable)');
    expect(html).toContain('saved (unavailable)');
    client.clear();
  });
});
