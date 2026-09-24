import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/host/src/app.js';
import { HostGateway } from '../../packages/transport/src/index.js';
import type { EngineAdapter, EngineRunInput } from '@ciel/contracts';
const root = await mkdtemp(path.join(os.tmpdir(), 'ciel-browser-test-'));
function fake(): EngineAdapter {
  const approvals = new Map<string, () => void>();
  return {
    id: 'codex',
    async status() { return { id: 'codex', name: 'Deterministic test engine', installed: true, authenticated: true, models: [{ id: 'test', name: 'Test model' }], capabilities: { resume: true, approvals: true, modelDiscovery: true, permissions: ['full-access', 'ask'], nativeExtensions: false } }; },
    async login() { return { status: 'completed', message: 'Test fixture only' }; },
    async run(input: EngineRunInput) {
      input.emit({ type: 'session', sessionId: input.sessionId ?? `native-${input.taskId}` });
      input.emit({ type: 'text.delta', text: 'Working asynchronously. ' });
      if (input.prompt.includes('activity-check')) {
        const next = input.prompt.includes('activity follow-up');
        // Persist the old adapter's noisy/repeated events to exercise history compatibility.
        input.emit({ type: 'tool.started', id: 'message', name: 'userMessage', input: '{}' });
        input.emit({ type: 'tool.completed', id: 'message', output: '{}', success: true });
        const tool = { type: 'tool.started' as const, id: 'native-call', name: next ? 'commandExecution' : 'webSearch', input: JSON.stringify(next ? { command: 'pwd' } : { type: 'webSearch', action: { query: 'Malus domestica Wikipedia' } }) };
        input.emit(tool); input.emit(tool);
        input.emit({ type: 'tool.completed', id: 'native-call', output: next ? 'Project directory' : 'Found the Wikipedia article', success: true });
      }
      if (input.prompt.includes('ask for approval')) {
        await new Promise<void>((resolve, reject) => {
          approvals.set(input.runId, resolve);
          input.signal.addEventListener('abort', () => { approvals.delete(input.runId); reject(new Error('Cancelled')); }, { once: true });
          input.emit({ type: 'approval', id: 'test-approval', title: 'Continue this test?', description: 'This deterministic test is waiting for your answer.', choices: ['Continue', 'Cancel'] });
        });
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, input.prompt.includes('slow') ? 5500 : 800);
        input.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
      });
      input.emit({ type: 'text.delta', text: 'Task complete.' });
      return { sessionId: `native-${input.taskId}` };
    },
    async steer() {},
    async approve(runId) { approvals.get(runId)?.(); approvals.delete(runId); }, async dispose() {},
  };
}
async function host(name: string, port: number) {
  const dataDir = path.join(root, name); let gateway: HostGateway;
  const app = await createApp({ dataDir, hostName: name, adapters: { codex: fake() }, configure: async (server, context) => { gateway = new HostGateway(dataDir, context.host); await gateway.register(server); }, listHosts: () => gateway.listHosts() });
  const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/bootstrap', headers: { host: `127.0.0.1:${port}` } });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  const folder = path.join(root, `${name}-project`); await mkdir(folder);
  const project = (await app.inject({ method: 'POST', url: `/api/v1/h/${app.ciel.host.id}/projects`, headers: { cookie }, payload: { name: `${name} project`, path: folder } })).json();
  const second = path.join(root, `${name}-other`); await mkdir(second);
  await app.inject({ method: 'POST', url: `/api/v1/h/${app.ciel.host.id}/projects`, headers: { cookie }, payload: { name: `${name} other`, path: second } });
  await app.inject({ method: 'POST', url: `/api/v1/h/${app.ciel.host.id}/tasks`, headers: { cookie }, payload: { projectId: project.id, title: `${name} session`, engine: 'codex' } });
  app.ciel.library.create({ name: `${name} coding guide`, kind: 'skill', description: 'Readable example skill', engines: ['codex'], content: '# Project conventions\n\nRead the existing code before making changes.\n\n## Verification\n\nExplain the checks you ran.', enabled: true });
  await app.listen({ host: '127.0.0.1', port });
  return { app, cookie };
}
const alpha = await host('Alpha', 4517), beta = await host('Beta', 4518);
const code = (await beta.app.inject({ method: 'POST', url: '/api/v1/pairing', headers: { cookie: beta.cookie } })).json().code;
const paired = await alpha.app.inject({ method: 'POST', url: '/api/v1/hosts', headers: { cookie: alpha.cookie }, payload: { url: 'http://127.0.0.1:4518', code } });
if (paired.statusCode !== 200) throw new Error(`Could not pair test hosts: ${paired.statusCode}`);
async function close() { await Promise.all([alpha.app.close(), beta.app.close()]); await rm(root, { recursive: true, force: true }); process.exit(0); }
process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
