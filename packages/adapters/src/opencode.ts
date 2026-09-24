import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { AdapterOptions, AuthFlow, EngineAdapter, EngineRunInput, EngineRunResult, EngineStatus, ModelInfo, PermissionMode } from '@ciel/contracts';
import { capture, describeError, discoverExtensions, engineCommand, jsonSafe, object, prepareProfile, projectedMcp, redactNative, spawnEngine, stopEngine, string, stripProviderCredentials } from './common.js';

type Server = { base: string; password?: string; child?: ChildProcess; cwd: string; permission: PermissionMode; ready: Promise<void> };
type ActiveRun = { server: Server; sessionId: string; input: EngineRunInput };
type PendingApproval = { runId: string; server: Server; sessionId: string; nativeId: string };
const CAPABILITIES = { resume: true, approvals: true, modelDiscovery: true, permissions: ['full-access', 'ask', 'read-only'] as const, nativeExtensions: true };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error('Could not reserve OpenCode port')));
    });
  });
}

function permissionConfig(mode: PermissionMode): Record<string, unknown> {
  if (mode === 'full-access') return { '*': 'allow', external_directory: 'allow' };
  if (mode === 'ask') return { '*': 'ask' };
  return { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', lsp: 'allow', webfetch: 'allow', websearch: 'allow', external_directory: 'ask' };
}

export class OpenCodeAdapter implements EngineAdapter {
  readonly id = 'opencode' as const;
  private servers = new Map<string, Server>();
  private starting = new Map<string, Promise<Server>>();
  private active = new Map<string, ActiveRun>();
  private approvals = new Map<string, PendingApproval>();
  private generation = 0;

  constructor(private readonly options: AdapterOptions) {}

  private async env(permission: PermissionMode): Promise<NodeJS.ProcessEnv> {
    const profile = await prepareProfile(this.options, 'opencode');
    const xdg = {
      XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'),
      XDG_CACHE_HOME: join(profile, 'cache'), XDG_STATE_HOME: join(profile, 'state'),
    };
    await Promise.all(Object.values(xdg).map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    const env = stripProviderCredentials();
    for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key];
    const mcp = Object.fromEntries((await projectedMcp(this.options, 'opencode')).map(server => {
      for (const source of Object.values(server.env)) if (env[source] === undefined) throw new Error(`MCP environment variable ${source} is unavailable to OpenCode`);
      return [server.name, { type: 'local', command: [server.command, ...server.args], enabled: true,
        environment: Object.fromEntries(Object.entries(server.env).map(([target, source]) => [target, `{env:${source}}`])) }];
    }));
    return {
      ...env, ...xdg,
      OPENCODE_CONFIG_DIR: join(profile, 'config', 'opencode'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json', enabled_providers: ['openrouter'],
        permission: permissionConfig(permission), share: 'disabled', mcp,
      }),
    };
  }

  private async key(cwd: string, permission: PermissionMode): Promise<string> {
    return `${cwd}\u0000${permission}\u0000${JSON.stringify(await projectedMcp(this.options, 'opencode'))}`;
  }

  private async server(cwd: string, permission: PermissionMode): Promise<Server> {
    if (this.options.openCodeBaseUrl) {
      const external: Server = { base: this.options.openCodeBaseUrl.replace(/\/$/, ''), cwd, permission, ready: Promise.resolve() };
      await this.request(external, 'GET', '/global/health');
      return external;
    }
    const key = await this.key(cwd, permission);
    for (const [oldKey, oldServer] of this.servers) {
      if (oldKey !== key && oldServer.cwd === cwd && oldServer.permission === permission && ![...this.active.values()].some(run => run.server === oldServer)) {
        if (oldServer.child) await stopEngine(oldServer.child); this.servers.delete(oldKey);
      }
    }
    const existing = this.servers.get(key);
    if (existing) { await existing.ready; return existing; }
    const starting = this.starting.get(key);
    if (starting) return starting;
    const promise = this.startServer(cwd, permission, key);
    this.starting.set(key, promise);
    try { return await promise; }
    finally { this.starting.delete(key); }
  }

  private async startServer(cwd: string, permission: PermissionMode, key: string): Promise<Server> {
    const generation = this.generation;
    const port = await freePort();
    const password = randomUUID();
    const command = await engineCommand(this.options, 'opencode');
    const child = spawnEngine(command.file, [...command.prefix, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd, env: { ...await this.env(permission), OPENCODE_SERVER_PASSWORD: password }, stdin: 'ignore',
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    const server: Server = { base: `http://127.0.0.1:${port}`, password, child, cwd, permission, ready: Promise.resolve() };
    this.servers.set(key, server);
    child.on('exit', () => { if (this.servers.get(key) === server) this.servers.delete(key); });
    server.ready = (async () => {
      for (let i = 0; i < 40; i++) {
        if (child.exitCode !== null) throw new Error(`OpenCode server exited: ${stderr}`);
        try {
          const health = object(await this.request(server, 'GET', '/global/health', undefined, 800));
          if (health.healthy === true) return;
        } catch { /* Server is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      await stopEngine(child);
      throw new Error('OpenCode server did not become healthy');
    })();
    try {
      await server.ready;
      if (generation !== this.generation) { await stopEngine(child); throw new Error('OpenCode adapter was disposed during startup'); }
      return server;
    }
    catch (error) { this.servers.delete(key); throw error; }
  }

  private headers(server: Server): Record<string, string> {
    return { 'content-type': 'application/json', ...(server.password ? { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}` } : {}) };
  }

  private async request(server: Server, method: string, path: string, body?: unknown, timeoutMs = 5000): Promise<unknown> {
    const response = await fetch(new URL(path, server.base), {
      method, headers: this.headers(server), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path} failed (${response.status})`);
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private async provider(server: Server): Promise<{ connected: boolean; models: ModelInfo[]; defaultModel?: string }> {
    const data = object(await this.request(server, 'GET', '/provider'));
    const connected = Array.isArray(data.connected) && data.connected.includes('openrouter');
    const provider = (Array.isArray(data.all) ? data.all : []).map(object).find(item => item.id === 'openrouter');
    const defaultModel = string(object(data.default).openrouter);
    const raw = object(provider?.models);
    const models = Object.entries(raw).map(([id, value]): ModelInfo => {
      const details = object(value);
      const full = `openrouter/${id}`;
      return { id: full, name: string(details.name) ?? id, isDefault: id === defaultModel };
    });
    return { connected, models, defaultModel: defaultModel && `openrouter/${defaultModel}` };
  }

  async status(): Promise<EngineStatus> {
    const base: EngineStatus = { id: 'opencode', name: 'OpenCode + OpenRouter', installed: false, authenticated: false, models: [], capabilities: { ...CAPABILITIES, permissions: [...CAPABILITIES.permissions] } };
    try {
      if (!this.options.openCodeBaseUrl) {
        const command = await engineCommand(this.options, 'opencode');
        const version = await capture(command.file, [...command.prefix, '--version'], { env: await this.env('full-access'), timeoutMs: 3000 });
        if (version.code !== 0) throw new Error('OpenCode CLI unavailable');
        base.version = version.stdout.trim();
      }
      const profile = await prepareProfile(this.options, 'opencode');
      const server = await this.server(profile, 'full-access');
      const health = object(await this.request(server, 'GET', '/global/health'));
      base.installed = health.healthy === true;
      base.version ??= string(health.version);
      const provider = await this.provider(server);
      base.protocolHealthy = base.installed;
      base.authenticated = provider.connected;
      base.authMode = provider.connected ? 'OpenRouter API key' : 'not connected';
      base.models = provider.models;
      if (!base.authenticated) base.error = 'Add an OpenRouter API key to the CIEL OpenCode profile';
    } catch (error) { base.error = describeError(error); }
    return base;
  }

  async login(): Promise<AuthFlow> {
    return { status: 'unavailable', message: 'OpenCode uses an OpenRouter API key. Add it in CIEL settings.' };
  }

  async setApiKey(key: string): Promise<void> {
    if (!key.trim()) throw new Error('OpenRouter API key is required');
    const profile = await prepareProfile(this.options, 'opencode');
    const server = await this.server(profile, 'full-access');
    await this.request(server, 'PUT', '/auth/openrouter', { type: 'api', key }, 10000);
    for (const other of this.servers.values()) {
      if (other !== server) await this.request(other, 'PUT', '/auth/openrouter', { type: 'api', key }, 10000);
    }
  }

  private async stream(response: Response, server: Server, sessionId: string, input: EngineRunInput): Promise<void> {
    if (!response.body) throw new Error('OpenCode event stream has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const startedTools = new Set<string>();
    const completedTools = new Set<string>();
    const assistantMessages = new Set<string>();
    const pendingText = new Map<string, string[]>();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('OpenCode event stream ended before the session became idle');
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary).replace(/\r/g, '');
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let event: Record<string, unknown>;
        try { event = object(JSON.parse(data)); } catch { continue; }
        const properties = object(event.properties);
        const eventSession = string(properties.sessionID) ?? string(object(properties.info).sessionID) ?? string(object(properties.part).sessionID);
        if (eventSession !== sessionId) continue;
        const type = string(event.type);
        if (type === 'session.idle' || (type === 'session.status' && object(properties.status).type === 'idle')) return;
        if (type === 'session.error') throw new Error(String(redactNative(string(object(properties.error).message) ?? 'OpenCode session failed')));
        if (type === 'message.updated') {
          const info = object(properties.info);
          const messageId = string(info.id);
          if (messageId) {
            if (info.role === 'assistant') {
              assistantMessages.add(messageId);
              for (const delta of pendingText.get(messageId) ?? []) input.emit({ type: 'text.delta', text: delta });
            }
            pendingText.delete(messageId);
          }
        } else if (type === 'message.part.delta' && properties.field === 'text') {
          const messageId = string(properties.messageID);
          const delta = string(properties.delta);
          if (messageId && delta) {
            if (assistantMessages.has(messageId)) input.emit({ type: 'text.delta', text: delta, native: redactNative(event) });
            else {
              const prior = pendingText.get(messageId) ?? [];
              if (prior.join('').length < 100000) { prior.push(delta); pendingText.set(messageId, prior); }
            }
          }
        } else if (type === 'permission.asked') {
          const nativeId = string(properties.id);
          if (!nativeId) continue;
          const id = `${input.runId}:${nativeId}`;
          this.approvals.set(id, { runId: input.runId, server, sessionId, nativeId });
          input.emit({ type: 'approval', id, title: `Approve ${string(properties.permission) ?? 'action'}`, description: jsonSafe(redactNative(properties)), choices: ['once', 'always', 'reject'], native: redactNative(event) });
        } else if (type === 'message.part.updated') {
          const part = object(properties.part);
          const id = string(part.id);
          if (part.type === 'tool' && id) {
            const state = object(part.state);
            if (state.status === 'running' && !startedTools.has(id)) {
              startedTools.add(id);
              input.emit({ type: 'tool.started', id, name: string(part.tool) ?? 'tool', input: jsonSafe(redactNative(state.input)), native: redactNative(event) });
            } else if ((state.status === 'completed' || state.status === 'error') && !completedTools.has(id)) {
              completedTools.add(id);
              input.emit({ type: 'tool.completed', id, output: jsonSafe(redactNative(state.output ?? state.error)), success: state.status === 'completed', native: redactNative(event) });
            }
          }
        }
      }
    }
  }

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    if (input.model && !input.model.startsWith('openrouter/')) throw new Error('CIEL OpenCode accepts only OpenRouter models');
    const server = await this.server(input.cwd, input.permission);
    const provider = await this.provider(server);
    if (!provider.connected) throw new Error('OpenRouter API key is not connected in the CIEL OpenCode profile');
    const model = input.model ?? provider.defaultModel ?? provider.models[0]?.id;
    if (!model?.startsWith('openrouter/')) throw new Error('No OpenRouter model is available');
    const [, ...modelParts] = model.split('/');
    const session = input.sessionId
      ? object(await this.request(server, 'GET', `/session/${encodeURIComponent(input.sessionId)}`))
      : object(await this.request(server, 'POST', '/session', {}));
    const sessionId = string(session.id);
    if (!sessionId) throw new Error('OpenCode did not return a native session ID');
    input.emit({ type: 'session', sessionId });
    if (input.signal.aborted) throw new Error('OpenCode turn interrupted');
    const controller = new AbortController();
    const response = await fetch(new URL('/event', server.base), { headers: this.headers(server), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream unavailable (${response.status})`);
    const stream = this.stream(response, server, sessionId, input);
    void stream.catch(() => {});
    this.active.set(input.runId, { server, sessionId, input });
    const abort = () => { void this.request(server, 'POST', `/session/${encodeURIComponent(sessionId)}/abort`, {}, 5000).catch(() => {}); };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      await this.request(server, 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        model: { providerID: 'openrouter', modelID: modelParts.join('/') },
        parts: [{ type: 'text', text: input.prompt }],
      }, 30000);
      await stream;
      if (input.signal.aborted) throw new Error('OpenCode turn interrupted');
      const messages = await this.request(server, 'GET', `/session/${encodeURIComponent(sessionId)}/message`, undefined, 10000);
      const last = Array.isArray(messages) ? [...messages].reverse().map(object).find(item => object(item.info).role === 'assistant') : undefined;
      const info = object(last?.info);
      if (info.error) throw new Error(String(redactNative(string(object(info.error).message) ?? 'OpenCode turn failed')));
      const text = (Array.isArray(last?.parts) ? last.parts : []).map(object).filter(part => part.type === 'text').map(part => string(part.text) ?? '').join('');
      return { sessionId, text };
    } finally {
      controller.abort();
      input.signal.removeEventListener('abort', abort);
      this.active.delete(input.runId);
      for (const [id, approval] of this.approvals) if (approval.runId === input.runId) this.approvals.delete(id);
    }
  }

  async approve(runId: string, approvalId: string, decision: string): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.runId !== runId) throw new Error('OpenCode approval is no longer pending');
    if (!['once', 'always', 'reject'].includes(decision)) throw new Error('Unsupported OpenCode approval decision');
    await this.request(approval.server, 'POST', `/session/${encodeURIComponent(approval.sessionId)}/permissions/${encodeURIComponent(approval.nativeId)}`, { response: decision }, 10000);
    this.approvals.delete(approvalId);
  }

  async extensions() { return discoverExtensions(this.options, 'opencode'); }

  async dispose(): Promise<void> {
    this.generation++;
    await Promise.allSettled([...this.starting.values()]);
    for (const run of this.active.values()) await this.request(run.server, 'POST', `/session/${encodeURIComponent(run.sessionId)}/abort`, {}, 3000).catch(() => {});
    for (const server of this.servers.values()) if (server.child) await stopEngine(server.child);
    this.servers.clear();
    this.active.clear();
    this.approvals.clear();
  }
}
