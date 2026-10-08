/**
 * Plain-language help for the workflow editor: what each step type does, what each setting means,
 * what a step changes outside Azhi, and a one-sentence reading of a configured step.
 */
export type Step = Record<string, any>;
export interface ToolInfo { id: string; version: number; effect: string; description?: string }

export const TYPE_HELP: Record<string, string> = {
  tool: 'Calls a registered tool, such as GitHub, Jira or Slack, with the arguments you give it.',
  agent: 'Hands a task to a model or an OpenCode agent. It gets the input you map in, works inside the place you choose, and must answer in the shape you set. Azhi stops it at the limits.',
  script: 'Runs your own code in a sandbox and returns what it prints as the step output.',
  retrieve: 'Looks up passages from your datasets so later steps can use them.',
  condition: 'Picks one path. The expression returns a route name and only the steps on that route run.',
  parallel: 'Runs the same step once for every item in a list, several at a time.',
  loop: 'Repeats a step until the stop rule is true or the limit is reached.',
  subworkflow: 'Runs another published workflow as one step and uses its output.',
  approval: 'Pauses the run until a person decides. Nothing after it starts while it waits, and the decision is kept in the action ledger.',
  report: 'Fills a template into a document that is kept with the run.',
  notify: 'Sends a message to Slack.',
};

/** Help for a setting, keyed by "<step type>.<key>", then by "<key>" for settings every type shares. */
export const FIELD_HELP: Record<string, string> = {
  'tool.tool': 'Which registered tool to call, as id@version. The tools page lists what each one reads or changes.',
  'tool.arguments': 'The values passed to the tool. Use {ref: inputs.x} to read a workflow input or {ref: nodes.step.output.field} to read an earlier step.',
  'tool.project': 'Keeps only these fields of the tool output, so later steps and the ledger hold less.',
  'tool.guard': 'A CEL rule checked on the final arguments. If it is false the call is refused. Use it to pin a write to the thing under review.',
  'agent.profile': 'The saved prompt, skills and allowed tools for this agent, as name@version.',
  'agent.executor': 'What runs the agent. Empty uses the built-in model agent; opencode runs OpenCode in a checkout.',
  'agent.input': 'What the agent is given to work on. Map in earlier outputs; nothing else is visible to it.',
  'agent.output_schema': 'The JSON schema the answer must match. A reply that does not match fails the step instead of passing bad data on.',
  'agent.tools': 'The tools the agent may call itself. Anything not listed is unreachable for it.',
  'agent.datasets': 'Datasets the agent may search.',
  'agent.budget': 'Hard limits such as max_tool_calls, max_output_tokens and max_cost_usd. When one is hit the step stops and the run records why.',
  'agent.workspace': 'Where it works: the repository, the ref to check out and the credential used to clone. The agent never sees the credential value.',
  'script.runtime': 'The language the script runs in.',
  'script.entrypoint': 'The file in the package to run.',
  'script.input': 'The JSON the script receives.',
  'script.output_schema': 'The JSON schema its output must match.',
  'retrieve.datasets': 'The datasets to search.',
  'retrieve.query': 'What to search for, usually a ref to an input or an earlier output.',
  'retrieve.top_k': 'How many passages to return.',
  'retrieve.filters': 'Narrow the search by dataset metadata.',
  'condition.expression': 'A CEL expression that returns one of the route names below.',
  'condition.routes': 'Route name to the steps that run only on that route.',
  'condition.default': 'The route taken when the expression returns something else.',
  'parallel.for_each': 'The list to go through, one run per item.',
  'parallel.node': 'The step to run for each item.',
  'parallel.max_concurrency': 'How many items run at once.',
  'parallel.join': 'all waits for every item; any continues after the first success.',
  'loop.initial': 'The state the first iteration starts with.',
  'loop.node': 'The step repeated each time; it can read state and iteration.',
  'loop.exit': 'A CEL rule that stops the loop when it becomes true.',
  'loop.max_iterations': 'A hard cap so a loop cannot run forever.',
  'loop.on_max': 'fail marks the step failed at the cap; continue moves on with the last state.',
  'subworkflow.workflow': 'The id of a published workflow, optionally with @version.',
  'subworkflow.input': 'The input the called workflow receives.',
  'approval.role': 'The lowest role allowed to decide. Higher roles can decide too.',
  'approval.message': 'The question the approver is asked.',
  'approval.payload': 'The facts shown with the question. An approval with no details is a rubber stamp, so the run plan warns about it.',
  'approval.decision_schema': 'A form the approver fills in with the decision, as a JSON schema.',
  'approval.expires_in': 'How long to wait for a decision, for example 24h.',
  'approval.on_expiry': 'fail ends the step with an error; reject treats it as a rejection.',
  'report.template': 'The template file the report is filled from.',
  'report.format': 'The format of the document.',
  'report.input': 'The data the template can use.',
  'report.summary': 'A short summary shown beside the report on the run page.',
  'notify.destination': 'The Slack channel ID. The bot must be in the channel.',
  'notify.message': 'The text to send.',
  'notify.guard': 'A CEL rule checked on the final arguments. Use it to pin the message to the configured channel.',
  timeout: 'How long the step may run before it is stopped.',
  retry: 'How many times to try again after a failure, for example max_attempts: 3.',
};

export function helpFor(type: string, key: string): string | undefined {
  return FIELD_HELP[`${type}.${key}`] ?? FIELD_HELP[key];
}

export type Effect = { label: string; tone: 'ok' | 'warn' | 'idle' };

/** What a step does to the outside world, as short chips for the canvas and the panel. */
export function effectsOf(step: Step, tools: ToolInfo[]): Effect[] {
  const out: Effect[] = [];
  switch (step.type) {
    case 'tool': {
      const ref = typeof step.tool === 'string' ? step.tool : '';
      const t = tools.find((x) => `${x.id}@${x.version}` === ref);
      if (!t) break;
      out.push(t.effect === 'read' ? { label: `reads ${t.id.split('.')[0]}`, tone: 'ok' } : { label: `writes to ${t.id.split('.')[0]}`, tone: 'warn' });
      break;
    }
    case 'notify': out.push({ label: step.channel && step.channel !== 'slack' ? `sends ${step.channel} message` : 'sends Slack message', tone: 'warn' }); break;
    case 'approval': out.push({ label: 'waits for a person', tone: 'idle' }); break;
    case 'agent': if (step.workspace) out.push({ label: 'reads a checkout', tone: 'ok' }); break;
    case 'script': out.push({ label: 'runs your code', tone: 'idle' }); break;
    case 'subworkflow': out.push({ label: `runs ${step.workflow ?? 'a workflow'}`, tone: 'idle' }); break;
  }
  return out;
}

/** The step as one sentence, built from its settings. */
export function sentenceOf(step: Step, tools: ToolInfo[], after: string[]): string {
  const when = after.length ? `After ${after.join(' and ')} finishes` : 'First';
  const lead = `${when}, `;
  switch (step.type) {
    case 'tool': {
      const ref = typeof step.tool === 'string' ? step.tool : 'a tool';
      const t = tools.find((x) => `${x.id}@${x.version}` === ref);
      return `${lead}Azhi calls ${ref}${t?.description ? ` (${t.description.replace(/\.$/, '')})` : ''}${t && t.effect !== 'read' ? '. It changes something outside Azhi' : ''}.`;
    }
    case 'agent': {
      const who = step.executor ? step.executor : 'the built-in model';
      const lim = step.budget?.max_tool_calls ? ` for up to ${step.budget.max_tool_calls} tool calls` : '';
      const tm = step.timeout ? ` and ${step.timeout}` : '';
      const ws = step.workspace?.repo ? ' in its own checkout of the repository' : '';
      return `${lead}${who} runs ${step.profile ?? 'an agent'}${ws}${lim}${tm}, and must answer in the shape of ${typeof step.output_schema === 'string' ? step.output_schema : 'its output schema'}.`;
    }
    case 'script': return `${lead}Azhi runs ${step.entrypoint ?? 'a script'} with ${step.runtime ?? 'python'} in a sandbox.`;
    case 'retrieve': return `${lead}Azhi searches ${(step.datasets ?? []).join(', ') || 'the datasets'} and returns the top ${step.top_k ?? 'few'} passages.`;
    case 'condition': {
      const routes = Object.keys(step.routes ?? {});
      return `${lead}Azhi evaluates a rule and follows ${routes.length ? `one of ${routes.join(', ')}` : 'a route'}; steps on the other routes are skipped.`;
    }
    case 'parallel': return `${lead}Azhi runs one step per item of the list${step.max_concurrency ? `, ${step.max_concurrency} at a time` : ''}.`;
    case 'loop': return `${lead}Azhi repeats a step until the stop rule is true, at most ${step.max_iterations ?? 'a set number of'} times.`;
    case 'subworkflow': return `${lead}Azhi runs the workflow ${step.workflow ?? ''} and uses its output.`;
    case 'approval': return `${lead}the run waits for someone with the ${step.role ?? 'operator'} role or higher to approve or reject${step.expires_in ? `, up to ${step.expires_in}` : ''}. ${step.payload ? 'They see the details you chose.' : 'They would see no details yet.'}`;
    case 'report': return `${lead}Azhi fills ${step.template ?? 'a template'} into a ${step.format ?? 'markdown'} document kept with the run.`;
    case 'notify': return `${lead}Azhi sends a Slack message to the configured channel.`;
    default: return `${lead}this step runs.`;
  }
}
