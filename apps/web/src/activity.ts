import type { EngineId, HostEvent, Run } from '@ciel/contracts';

export interface ActivityItem {
  id: string;
  kind: 'tool' | 'approval' | 'error';
  label: string;
  nativeName: string;
  engine: EngineId;
  status: 'running' | 'completed' | 'failed' | 'attention' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  input?: string;
  output?: string;
  description?: string;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
function parsed(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
}
function pretty(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
const nonTools = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'hookPrompt', 'functionCallOutput', 'subAgentActivity', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode']);
const names: Record<string, string> = {
  webSearch: 'Web search', WebSearch: 'Web search', websearch: 'Web search', web_search: 'Web search',
  webFetch: 'Fetch webpage', WebFetch: 'Fetch webpage', webfetch: 'Fetch webpage',
  commandExecution: 'Run command', Bash: 'Run command', bash: 'Run command', shell: 'Run command',
  fileChange: 'Edit files', Edit: 'Edit file', edit: 'Edit file', MultiEdit: 'Edit files', apply_patch: 'Apply patch', patch: 'Apply patch',
  Write: 'Write file', write: 'Write file', Read: 'Read file', read: 'Read file',
  Grep: 'Search file contents', grep: 'Search file contents', Glob: 'Find files', glob: 'Find files', list: 'List files',
  Task: 'Delegate task', Agent: 'Delegate task', task: 'Delegate task', collabAgentToolCall: 'Agent action',
  TodoWrite: 'Update plan', todowrite: 'Update plan', TodoRead: 'Read plan', todoread: 'Read plan',
  AskUserQuestion: 'Ask a question', question: 'Ask a question', imageView: 'View image', imageGeneration: 'Generate image',
};
function toolInfo(event: HostEvent) {
  const native = object(event.data.native);
  const item = object(object(native.params).item);
  const part = object(object(native.properties).part);
  const source = { ...parsed(event.data.input), ...part, ...item };
  const name = text(event.data.name) || (part.type === 'tool' ? text(part.tool) : text(source.type));
  if (nonTools.has(name) || nonTools.has(text(source.type))) return null;
  let nativeName = name;
  if (name === 'mcpToolCall' && source.tool) nativeName = [source.server, source.tool].filter(Boolean).join('/');
  if ((name === 'dynamicToolCall' || name === 'collabAgentToolCall') && source.tool) nativeName = [source.namespace, source.tool].filter(Boolean).join('/');
  if (!nativeName || nativeName === 'unknown' || nativeName === 'activity') return null;
  const nativeTool = text(source.tool);
  const mapped = (key: string) => Object.hasOwn(names, key) ? names[key] : undefined;
  const label = mapped(name) || mapped(nativeTool) || (nativeTool || nativeName).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const usefulInput = source.arguments ?? source.input ?? source.command ?? source.action ?? event.data.input;
  return { nativeName, label: label.charAt(0).toUpperCase() + label.slice(1), input: pretty(usefulInput) };
}

/** Present actual work, not the host event journal. IDs are scoped to one run. */
export function activityForRun(events: HostEvent[], run: Run): ActivityItem[] {
  const items = new Map<string, ActivityItem>();
  const ignored = new Set<string>();
  const finished = !['running', 'queued', 'waiting'].includes(run.status);
  for (const event of events.filter(event => event.runId === run.id).sort((a, b) => a.seq - b.seq)) {
    const nativeId = text(event.data.id);
    if (event.type === 'tool.started') {
      const id = `tool:${nativeId || event.seq}`;
      const info = toolInfo(event);
      if (!info) { ignored.add(id); continue; }
      const previous = items.get(id);
      items.set(id, { id, kind: 'tool', engine: run.engine, status: 'running', startedAt: event.createdAt, ...info, ...previous, input: info.input || previous?.input });
    } else if (event.type === 'tool.completed') {
      const id = `tool:${nativeId || event.seq}`;
      if (ignored.has(id)) continue;
      const previous = items.get(id);
      const info = toolInfo(event);
      // A completion without a known start is only useful if it carries a name.
      if (!previous && !info) continue;
      items.set(id, { id, kind: 'tool', engine: run.engine, startedAt: event.createdAt, nativeName: '', label: 'Tool call', ...info, ...previous,
        status: event.data.success === false ? 'failed' : 'completed', finishedAt: event.createdAt, output: pretty(event.data.output) });
    } else if (event.type === 'approval.requested') {
      items.set(`approval:${nativeId}`, { id: `approval:${nativeId}`, kind: 'approval', engine: run.engine, nativeName: '',
        label: text(event.data.title) || 'Input requested', description: text(event.data.description), status: 'attention', startedAt: event.createdAt });
    } else if (event.type === 'approval.resolved') {
      const previous = items.get(`approval:${nativeId}`);
      if (previous) { previous.status = 'completed'; previous.finishedAt = event.createdAt; previous.output = text(event.data.decision) || 'Answered'; }
    }
  }
  for (const item of items.values()) {
    if (finished && (item.status === 'running' || item.status === 'attention')) {
      item.status = 'stopped'; item.finishedAt = run.finishedAt;
    }
  }
  if (run.status === 'failed' || run.status === 'interrupted') items.set('run-error', {
    id: 'run-error', kind: 'error', engine: run.engine, nativeName: '', label: run.status === 'failed' ? 'Run failed' : 'Run interrupted',
    status: 'failed', startedAt: run.finishedAt || run.createdAt, description: run.error || 'This run stopped before it finished.',
  });
  return [...items.values()];
}

export function activityDuration(item: Pick<ActivityItem, 'startedAt' | 'finishedAt'>): string {
  if (!item.finishedAt) return '';
  const ms = Date.parse(item.finishedAt) - Date.parse(item.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1s';
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;
}
