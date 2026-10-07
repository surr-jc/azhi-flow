/** Executor capability declarations (spec section 9). The run plan evaluates nodes against these. */
export interface ExecutorCapabilities {
  streaming: boolean;
  resume: 'native' | 'checkpoint-only' | 'none';
  cancellation: 'confirmed' | 'best-effort' | 'none';
  gatewayTools: 'native-mcp' | 'bridged' | 'none';
  ambientTools: 'disableable' | 'restrictable' | 'uncontrolled';
  structuredOutput: 'enforced' | 'validated' | 'none';
  usage: 'reported' | 'partial' | 'unavailable';
  platforms: Array<'linux' | 'macos' | 'windows'>;
  /** Fields not yet verified by a conformance run; the run plan marks them unverified. */
  unverified?: Array<keyof Omit<ExecutorCapabilities, 'unverified' | 'compacts'>>;
  /** Whether the executor compacts context itself; if so, the platform does not (spec section 11). */
  compacts: boolean;
}

export interface ExecutorDeclaration {
  id: string;
  version: string;
  /** Model providers the adapter can drive. */
  providers: Array<'anthropic' | 'openai' | 'github-copilot' | 'openai-chatgpt'>;
  capabilities: ExecutorCapabilities;
  notes: string[];
}

export const EXECUTORS: Record<string, ExecutorDeclaration> = {
  'model-agent': {
    id: 'model-agent',
    version: '0.1.0',
    providers: ['anthropic', 'openai'],
    capabilities: {
      streaming: false,
      resume: 'checkpoint-only',
      cancellation: 'confirmed',
      gatewayTools: 'native-mcp',
      ambientTools: 'disableable',
      structuredOutput: 'validated',
      usage: 'reported',
      platforms: ['linux', 'macos', 'windows'],
      compacts: false,
    },
    notes: ['Platform-owned tool loop: every tool call goes through the gateway', 'No ambient tools exist'],
  },
  // Recorded from phase 0 spike 6 (OpenCode 1.18.34); see docs/phase-0-results.md.
  opencode: {
    id: 'opencode',
    version: '1.18.34',
    providers: ['anthropic', 'github-copilot', 'openai-chatgpt'],
    capabilities: {
      streaming: true,
      resume: 'native',
      cancellation: 'best-effort',
      gatewayTools: 'bridged',
      ambientTools: 'restrictable',
      structuredOutput: 'validated',
      usage: 'partial',
      platforms: ['linux', 'macos'],
      unverified: ['usage', 'structuredOutput', 'cancellation'],
      compacts: true,
    },
    notes: ['Built-in tools restricted by deny-all permission rules; OpenCode still lists them', 'Runs with an isolated HOME so host skills and config do not leak in'],
  },
  // Claude Agent SDK 0.3.289: the SDK drives the Claude Code runtime. Verified in test/claude-agent-sdk.test.ts
  // against a scripted Anthropic endpoint; not yet against a live model.
  'claude-agent-sdk': {
    id: 'claude-agent-sdk',
    version: '0.3.289',
    providers: ['anthropic'],
    capabilities: {
      streaming: true,
      resume: 'native',
      cancellation: 'best-effort',
      gatewayTools: 'bridged',
      ambientTools: 'restrictable',
      structuredOutput: 'validated',
      usage: 'reported',
      platforms: ['linux', 'macos', 'windows'],
      unverified: ['resume'],
      compacts: true,
    },
    notes: ['Built-in tools are switched off (no tools) and only the gateway bridge is allowed, in dontAsk mode', 'Runs with an isolated HOME, no settings files, no persisted skills or plugins'],
  },
  // EXPERIMENTAL. Codex CLI 0.160.0 (installed separately: AZHI_CODEX_BIN or `codex` on PATH), advertised by
  // a worker only with AZHI_EXPERIMENTAL_CODEX=1. Codex defers MCP tools behind its own tool_search step, so
  // whether a live model finds the gateway bridge is unverified; the scripted conformance suite cannot
  // exercise it (see test/harness-executors.test.ts).
  codex: {
    id: 'codex',
    version: '0.160.0',
    providers: ['openai'],
    capabilities: {
      streaming: true,
      resume: 'checkpoint-only',
      cancellation: 'best-effort',
      gatewayTools: 'bridged',
      ambientTools: 'uncontrolled',
      structuredOutput: 'validated',
      usage: 'partial',
      platforms: ['linux', 'macos', 'windows'],
      unverified: ['gatewayTools', 'ambientTools', 'usage', 'structuredOutput', 'cancellation', 'resume'],
      compacts: true,
    },
    notes: ['Experimental and unverified against a live model', 'Codex\'s shell tool cannot be removed, only sandboxed read-only with approvals off, so a node can refuse it with requires.enforced_restrictions', 'Runs with an isolated CODEX_HOME and web search off'],
  },
};

/**
 * A Claude plan token (`claude setup-token`, sk-ant-oat...). Anthropic allows a Pro or Max plan only
 * through its own runtime (Claude Code and the Agent SDK), so only the claude-agent-sdk executor takes one.
 */
export const isClaudePlanToken = (v: string) => v.trim().startsWith('sk-ant-oat');
export const CLAUDE_PLAN_ONLY_SDK =
  'this credential is a Claude plan token (claude setup-token). Anthropic allows a Claude plan only through Claude Code and its Agent SDK: give this step executor: claude-agent-sdk, or use an API key (anthropic-api-key) here';

/** Executors that run on a worker as a separate harness process, bridged to the gateway over MCP. */
export const HARNESS_EXECUTORS = ['opencode', 'claude-agent-sdk', 'codex'] as const;
export type HarnessExecutor = (typeof HARNESS_EXECUTORS)[number];
export const isHarness = (e: string): e is HarnessExecutor => (HARNESS_EXECUTORS as readonly string[]).includes(e);
