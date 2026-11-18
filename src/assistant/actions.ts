import type { Message } from '../agents/providers.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { audit } from '../server/catalog.js';
import { checkCall, type AssistantDeps, type Caller } from './tools.js';

/** The longest conversation the assistant keeps: the web refuses more, Slack trims to it. */
export const MAX_HISTORY_MESSAGES = 200;
export const MAX_HISTORY_BYTES = 1_000_000;

/**
 * An action the assistant proposed, run once the person confirms it: the role and arguments are
 * checked again here. Shared by the web route and the Slack buttons.
 */
export async function runConfirmedAction(d: AssistantDeps, p: Caller, name: string, rawArgs: unknown, via: 'web' | 'slack') {
  const { tool, args } = checkCall(p, name, rawArgs);
  if (tool.effect !== 'act') throw new AzhiError(ErrorClass.invalidInput, `${name} is not an action`);
  const result = await tool.run(d, p, args);
  await audit(d.ctx, p.workspaceId, p.userId, 'assistant.action', { tool: tool.name, args, via });
  return result;
}

export const tooLong = (messages: Message[]) => messages.length > MAX_HISTORY_MESSAGES || JSON.stringify(messages).length > MAX_HISTORY_BYTES;

/**
 * Drops the oldest whole turns until the conversation fits. A turn starts at a user message that
 * answers no tool call, so a tool_use is never left without its tool_result (or the reverse).
 */
export function trimHistory(messages: Message[]): Message[] {
  let out = messages;
  while (tooLong(out)) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user' && !m.content.some((b) => b.type === 'tool_result'));
    out = next === -1 ? [] : out.slice(next);
  }
  return out;
}
