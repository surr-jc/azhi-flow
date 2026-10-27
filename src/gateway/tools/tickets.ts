import { ErrorClass } from '../../lib/errors.js';
import { SendError } from '../ledger.js';

/**
 * `ticket.normalize`: turns a Jira issue (from a Jira MCP server, or the Jira REST shape) or a
 * GitHub issue (`github.issue`) into the one ticket shape the SDLC example's agents read:
 * `{source, key, title, description, priority, reporter, status, labels, url}`. No network.
 *
 * The text is untrusted (anyone who can edit the ticket wrote it). This does not make it safe for
 * agents (the run's taint rules do that), but it keeps it plain: control, zero-width and
 * bidirectional characters are removed, the title is one line, and every field has a length cap,
 * so a ticket cannot hide text from the people approving the run or flood an agent's context.
 */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_SHORT = 100;

// C0/C1 controls except tab and newline, zero-width and bidi controls, BOM.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

export function plain(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(HIDDEN, '').trim();
  return s.length > max ? `${s.slice(0, max)}\n[truncated at ${max} characters]` : s;
}

export function line(text: unknown, max: number): string {
  const s = String(text ?? '').replace(HIDDEN, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Text from Atlassian Document Format (Jira Cloud REST v3 descriptions). */
function adfText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (node.type === 'text') return String(node.text ?? '');
  if (node.type === 'hardBreak') return '\n';
  const inner = adfText(node.content ?? []);
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'rule'].includes(node.type) ? `${inner}\n` : inner;
}

/** A name from a string or an object with a name-like field (Jira users, priorities, statuses). */
function nameOf(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v.display_name ?? v.displayName ?? v.name ?? v.value ?? v.login ?? v.emailAddress ?? '');
}

/** MCP servers return the issue as an object or as JSON text, sometimes wrapped. */
function unwrap(raw: unknown): any {
  let v: any = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new SendError('the Jira tool returned text that is not a JSON issue', true, ErrorClass.contractViolation);
    }
  }
  if (v && typeof v === 'object' && !v.key && v.issue && typeof v.issue === 'object') v = v.issue;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SendError('the issue to normalize is not an object', true, ErrorClass.invalidInput);
  return v;
}

function jira(raw: unknown) {
  const v = unwrap(raw);
  // Jira REST nests under `fields`; MCP servers (mcp-atlassian) flatten it.
  const f = v.fields && typeof v.fields === 'object' ? { ...v.fields, ...v } : v;
  const key = line(v.key, MAX_SHORT);
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new SendError(`the Jira issue has no valid key (got '${key}')`, true, ErrorClass.contractViolation);
  const description = typeof f.description === 'object' && f.description ? adfText(f.description) : f.description;
  const labels = Array.isArray(f.labels) ? f.labels.map((l: unknown) => line(nameOf(l), MAX_SHORT)).filter(Boolean).slice(0, 50) : [];
  const browse = typeof v.self === 'string' ? v.self.replace(/\/rest\/api\/.*$/, `/browse/${key}`) : '';
  return {
    source: 'jira',
    key,
    title: line(f.summary ?? f.title, MAX_TITLE),
    description: plain(description, MAX_DESCRIPTION),
    priority: line(nameOf(f.priority), MAX_SHORT).toLowerCase(),
    reporter: line(nameOf(f.reporter), MAX_SHORT),
    status: line(nameOf(f.status), MAX_SHORT),
    labels,
    url: line(typeof v.url === 'string' ? v.url : browse, 500),
  };
}

const PRIORITY = /^(?:priority[\s:/-]*)?(p[0-4]|critical|high|medium|low)$/i;

function github(raw: unknown) {
  const v = unwrap(raw);
  const repo = line(v.repo, MAX_SHORT);
  const number = Number(v.number);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) throw new SendError('the GitHub issue has no repo and number', true, ErrorClass.contractViolation);
  const labels: string[] = Array.isArray(v.labels) ? v.labels.map((l: unknown) => line(nameOf(l), MAX_SHORT)).filter(Boolean).slice(0, 50) : [];
  const comments = (Array.isArray(v.comments) ? v.comments : []).map((c: any) => `Comment by ${line(c.author, MAX_SHORT)}:\n${plain(c.body, 4000)}`);
  const priority = labels.map((l) => l.match(PRIORITY)?.[1]).find(Boolean) ?? '';
  return {
    source: 'github',
    key: `${repo}#${number}`,
    title: line(v.title, MAX_TITLE),
    description: plain([v.body ?? '', ...comments].filter(Boolean).join('\n\n'), MAX_DESCRIPTION),
    priority: priority.toLowerCase(),
    reporter: line(v.author, MAX_SHORT),
    status: line(v.state, MAX_SHORT),
    labels,
    url: line(v.url, 500),
  };
}

export function normalizeTicket(args: { source?: unknown; issue?: unknown }) {
  if (args.source === 'jira') return jira(args.issue);
  if (args.source === 'github') return github(args.issue);
  throw new SendError(`source must be jira or github, got '${line(args.source, MAX_SHORT)}'`, true, ErrorClass.invalidInput);
}
