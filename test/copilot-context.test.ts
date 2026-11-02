import { describe, expect, it } from 'vitest';
import { copilotPlanModels } from '../src/builder/models.js';

describe('Copilot model context window', () => {
  it('carries the window Copilot lists and leaves it out when Copilot does not say', () => {
    const models = copilotPlanModels([
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', model_picker_enabled: true, capabilities: { type: 'chat', family: 'gpt-6-luna', limits: { max_context_window_tokens: 400000 } } },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', model_picker_enabled: true, capabilities: { type: 'chat', family: 'claude-sonnet-5' } },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', model_picker_enabled: true, capabilities: { type: 'chat', family: 'claude-haiku-4.5', limits: { max_context_window_tokens: 'many' } } },
    ]);
    expect(models.find((m) => m.id === 'gpt-6-luna')?.context_window).toBe(400000);
    expect(models.find((m) => m.id === 'claude-sonnet-5')).not.toHaveProperty('context_window');
    expect(models.find((m) => m.id === 'claude-haiku-4.5')).not.toHaveProperty('context_window');
  });
});
