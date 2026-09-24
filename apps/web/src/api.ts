import type {
  Approval, AuthFlow, CielUpdateStatus, CreateTaskInput, EngineId, EngineStatus, HostConnection,
  HostSettings, HostState, LibraryItem, Preview, Project, Run, SubmitRunInput, Task, TaskDetail,
} from '@ciel/contracts';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json() as { error?: string }; message = body.error || message; } catch { /* Preserve HTTP status. */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const body = (value: unknown) => JSON.stringify(value);
export const hostPath = (hostId: string) => `/api/v1/h/${encodeURIComponent(hostId)}`;
const scoped = (hostId: string, route: string) => `${hostPath(hostId)}${route}`;

export const api = {
  bootstrap: (signal?: AbortSignal) => json<{ hostId: string }>('/api/v1/bootstrap', { method: 'POST', signal }),
  hosts: (signal?: AbortSignal) => json<HostConnection[]>('/api/v1/hosts', { signal }),
  pairCode: () => json<{ code: string; expiresAt: string }>('/api/v1/pairing', { method: 'POST' }),
  pairHost: (url: string, code: string) => json<HostConnection>('/api/v1/hosts', { method: 'POST', body: body({ url, code }) }),
  forgetHost: (id: string) => json<void>(`/api/v1/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  state: (hostId: string, signal?: AbortSignal) => json<HostState>(scoped(hostId, '/state'), { signal }),
  updateStatus: (hostId: string, signal?: AbortSignal) => json<CielUpdateStatus>(scoped(hostId, '/updates'), { signal }),
  applyUpdate: (hostId: string) => json<CielUpdateStatus>(scoped(hostId, '/updates/apply'), { method: 'POST' }),
  task: (hostId: string, taskId: string, signal?: AbortSignal) => json<TaskDetail>(scoped(hostId, `/tasks/${encodeURIComponent(taskId)}`), { signal }),
  createProject: (hostId: string, name: string, path: string) => json<Project>(scoped(hostId, '/projects'), { method: 'POST', body: body({ name, path }) }),
  previews: (hostId: string, signal?: AbortSignal) => json<Preview[]>(scoped(hostId, '/previews'), { signal }),
  createPreview: (hostId: string, input: { projectId: string; name: string; port: number; command?: string; remote: boolean }) => json<Preview>(scoped(hostId, '/previews'), { method: 'POST', body: body(input) }),
  stopPreview: (hostId: string, id: string) => json<Preview>(scoped(hostId, `/previews/${encodeURIComponent(id)}/stop`), { method: 'POST' }),
  createTask: (hostId: string, input: CreateTaskInput) => json<Task>(scoped(hostId, '/tasks'), { method: 'POST', body: body(input) }),
  updateTask: (hostId: string, taskId: string, patch: Partial<Task>) => json<Task>(scoped(hostId, `/tasks/${encodeURIComponent(taskId)}`), { method: 'PATCH', body: body(patch) }),
  submitRun: (hostId: string, taskId: string, input: SubmitRunInput) => json<Run>(scoped(hostId, `/tasks/${encodeURIComponent(taskId)}/runs`), { method: 'POST', body: body(input) }),
  steer: (hostId: string, runId: string, prompt: string) => json<{ok:boolean}>(scoped(hostId, `/runs/${encodeURIComponent(runId)}/steer`), { method: 'POST', body: body({prompt}) }),
  readTask: (hostId: string, taskId: string, seq: number) => json<Task>(scoped(hostId, `/tasks/${encodeURIComponent(taskId)}/read`), { method: 'POST', body: body({ seq }) }),
  interrupt: (hostId: string, runId: string) => json<void>(scoped(hostId, `/runs/${encodeURIComponent(runId)}/interrupt`), { method: 'POST' }),
  approve: (hostId: string, approvalId: string, decision: string) => json<Approval>(scoped(hostId, `/approvals/${encodeURIComponent(approvalId)}`), { method: 'POST', body: body({ decision }) }),
  engines: (hostId: string, signal?: AbortSignal) => json<EngineStatus[]>(scoped(hostId, '/engines'), { signal }),
  runtimes: (hostId: string, signal?: AbortSignal) => json<RuntimeState[]>(scoped(hostId, '/runtimes'), { signal }),
  checkRuntime: (hostId: string, engineId: EngineId) => json<RuntimeState>(scoped(hostId, `/runtimes/${engineId}/check`), { method: 'POST' }),
  installRuntime: (hostId: string, engineId: EngineId) => json<RuntimeState>(scoped(hostId, `/runtimes/${engineId}/install`), { method: 'POST' }),
  network: (hostId: string) => json<{ url?: string; port?: number }>(scoped(hostId, '/network')),
  enableNetwork: (hostId: string) => json<{ url: string; port: number }>(scoped(hostId, '/network/enable'), { method: 'POST' }),
  login: (hostId: string, engineId: EngineId) => json<AuthFlow>(scoped(hostId, `/engines/${engineId}/login`), { method: 'POST' }),
  setOpenRouterKey: (hostId: string, key: string) => json<void>(scoped(hostId, '/engines/opencode/key'), { method: 'PUT', body: body({ key }) }),
  addLibrary: (hostId: string, item: Partial<LibraryItem>) => json<LibraryItem>(scoped(hostId, '/library'), { method: 'POST', body: body(item) }),
  updateLibrary: (hostId: string, id: string, item: Partial<LibraryItem>) => json<LibraryItem>(scoped(hostId, `/library/${encodeURIComponent(id)}`), { method: 'PATCH', body: body(item) }),
  deleteLibrary: (hostId: string, id: string) => json<void>(scoped(hostId, `/library/${encodeURIComponent(id)}`), { method: 'DELETE' }),
  exportLibrary: (hostId: string) => json<unknown>(scoped(hostId, '/library/export')),
  importLibrary: (hostId: string, data: unknown) => json<unknown>(scoped(hostId, '/library/import'), { method: 'POST', body: body(data) }),
  updateSettings: (hostId: string, patch: Partial<HostSettings>) => json<HostSettings>(scoped(hostId, '/settings'), { method: 'PATCH', body: body(patch) }),
};

export interface RuntimeState { engine: EngineId; installedVersion?: string; latestVersion?: string; state: 'idle' | 'checking' | 'installing' | 'ready' | 'failed'; message?: string }
