/** Shared host/UI/engine boundary. All identifiers are scoped to their host. */
export const API_VERSION = 1;
export const CIEL_VERSION = '0.1.0';
export const ENGINE_IDS = ['codex', 'claude', 'opencode'] as const;
export type EngineId = typeof ENGINE_IDS[number];
export type PermissionMode = 'full-access' | 'ask' | 'read-only';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface HostInfo { id: string; name: string; platform: string; version: string; online: boolean; local: boolean; url?: string }
export interface HostConnection extends HostInfo { lastSeenAt?: string }
export interface Project { id: string; hostId: string; name: string; path: string; createdAt: string }
export interface Task {
  id: string; hostId: string; projectId: string; title: string; engine: EngineId;
  model?: string; effort?: string; permission: PermissionMode; status: RunStatus | 'idle';
  archived: boolean; createdAt: string; updatedAt: string; lastReadSeq: number; attentionSeq: number;
}
export interface Run {
  id: string; taskId: string; hostId: string; engine: EngineId; model?: string;
  permission: PermissionMode; status: RunStatus; prompt: string;
  createdAt: string; startedAt?: string; finishedAt?: string; error?: string;
  nativeSessionId?: string; commandId: string;
}
export interface Message { id: string; taskId: string; runId?: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string; engine?: EngineId }
export interface HostEvent { seq: number; hostId: string; taskId?: string; runId?: string; type: string; data: Record<string, unknown>; createdAt: string }
export interface Approval { id: string; taskId: string; runId: string; title: string; description: string; choices: string[]; status: 'pending' | 'resolved'; decision?: string }
export interface FileChange { path: string; kind: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch?: string; binary?: boolean; truncated?: boolean }
export interface ChangeSet { runId: string; files: FileChange[]; capturedAt: string; warning?: string }
export interface ModelInfo { id: string; name: string; efforts?: string[]; defaultEffort?: string; isDefault?: boolean }
export interface EngineCapabilities { resume: boolean; approvals: boolean; modelDiscovery: boolean; permissions: PermissionMode[]; nativeExtensions: boolean }
export interface EngineStatus {
  protocolHealthy?: boolean;
  id: EngineId; name: string; installed: boolean; authenticated: boolean;
  version?: string; authMode?: string; accountLabel?: string; error?: string;
  models: ModelInfo[]; capabilities: EngineCapabilities;
}
export interface AuthFlow { status: 'pending' | 'completed' | 'unavailable'; url?: string; userCode?: string; message: string }
export interface NativeExtension { id: string; name: string; kind: 'skill' | 'plugin' | 'mcp'; enabled: boolean; source?: string }
export interface LibraryItem { id: string; name: string; description: string; kind: 'instruction' | 'memory' | 'skill' | 'mcp'; content: string; engines: EngineId[]; enabled: boolean; updatedAt: string }
export interface HostSettings { name: string; defaultPermission: PermissionMode; notifications: boolean; autoUpdate: boolean }
export interface Preview { id: string; projectId: string; name: string; port: number; url?: string; status: 'running' | 'stopped' | 'registered' | 'failed'; error?: string }
export interface HostState { host: HostInfo; projects: Project[]; tasks: Task[]; engines: EngineStatus[]; library: LibraryItem[]; settings: HostSettings; lastSeq: number; previews?: Preview[] }
export interface TaskDetail { task: Task; runs: Run[]; messages: Message[]; events: HostEvent[]; changes: ChangeSet[]; approvals: Approval[] }
export interface CreateTaskInput { projectId: string; title?: string; engine: EngineId; model?: string; effort?: string; permission?: PermissionMode }
export interface SubmitRunInput { prompt: string; commandId: string; engine?: EngineId; model?: string | null; effort?: string | null; permission?: PermissionMode }

export type AdapterEvent = (
  | { type: 'session'; sessionId: string }
  | { type: 'text.delta'; text: string; channel?: 'assistant' | 'reasoning' }
  | { type: 'tool.started'; id: string; name: string; input: string }
  | { type: 'tool.completed'; id: string; output: string; success: boolean }
  | { type: 'approval'; id: string; title: string; description: string; choices: string[] }
  | { type: 'status'; message: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }) & { native?: unknown };
export interface EngineRunInput {
  taskId: string; runId: string; cwd: string; prompt: string; sessionId?: string;
  model?: string; effort?: string; permission: PermissionMode; signal: AbortSignal;
  emit: (event: AdapterEvent) => void;
}
export interface EngineRunResult { sessionId?: string; text?: string }
export interface EngineAdapter {
  readonly id: EngineId;
  status(): Promise<EngineStatus>;
  login(): Promise<AuthFlow>;
  run(input: EngineRunInput): Promise<EngineRunResult>;
  approve(runId: string, approvalId: string, decision: string): Promise<void>;
  dispose(): Promise<void>;
  setApiKey?(key: string): Promise<void>;
  extensions?(): Promise<NativeExtension[]>;
}
export interface AdapterOptions { dataDir: string; binaries?: Partial<Record<EngineId, string>>; openCodeBaseUrl?: string }

/** REST routes: gateway uses /api/v1/h/:hostId and forwards only to paired hosts. */
export const API_ROUTES = {
  hosts: '/api/v1/hosts',
  host: (id: string) => `/api/v1/h/${encodeURIComponent(id)}`,
} as const;
// Host-scoped routes: GET /state; GET/POST /projects; POST /tasks;
// GET/PATCH /tasks/:id; POST /tasks/:id/runs; POST /tasks/:id/read {seq};
// POST /runs/:id/interrupt; POST /approvals/:id {decision}; GET /events?after=<seq> (SSE);
// GET /engines; POST /engines/:id/login; PUT /engines/opencode/key {key};
// GET/POST /library; PATCH/DELETE /library/:id; GET /library/export; POST /library/import;
// GET/PATCH /settings. Bodies and responses are JSON; errors: {error: string}.
// GET /state => HostState; GET /tasks/:id => TaskDetail; POST /tasks => Task;
// POST /tasks/:id/runs => Run (202); GET /hosts => HostConnection[].
