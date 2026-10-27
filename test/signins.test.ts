import { describe, expect, it } from 'vitest';
import { classifySecret, mismatch } from '../src/api/signins.js';

describe('classifying a secret without exposing it', () => {
  it('tells apart a GitHub CLI pointer, a ChatGPT sign-in, a Copilot sign-in and a pasted token', () => {
    expect(classifySecret('azhi:gh-cli')).toEqual({ kind: 'gh-cli', host: 'github.com' });
    expect(classifySecret('azhi:gh-cli:git.example.com')).toEqual({ kind: 'gh-cli', host: 'git.example.com' });
    expect(classifySecret(JSON.stringify({ openai: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } })).kind).toBe('chatgpt');
    expect(classifySecret(JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'gho_x' } })).kind).toBe('copilot');
    expect(classifySecret('github_pat_abc').kind).toBe('token');
    expect(classifySecret('{"something":{"else":1}}').kind).toBe('token');
  });

  it('flags a secret that holds the wrong kind of sign-in', () => {
    expect(mismatch(['copilot'], 'chatgpt', 'github-copilot-token')).toMatch(/holds ChatGPT sign-in.*needs GitHub Copilot sign-in/);
    expect(mismatch(['gh-cli', 'token'], 'gh-cli', 'github-read-token')).toBeUndefined();
    expect(mismatch(['token'], 'token', 'slack-bot-token')).toBeUndefined();
  });
});
