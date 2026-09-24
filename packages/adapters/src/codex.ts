import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AdapterOptions, EngineAdapter, EngineRunInput, EngineRunResult, EngineStatus, AuthFlow, ModelInfo } from '@ciel/contracts';
import { capture, describeError, discoverExtensions, engineCommand, jsonSafe, object, prepareProfile, projectedMcp, redactNative, resolveMcpEnvironment, spawnEngine, stopEngine, string, stripProviderCredentials } from './common.js';

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ActiveRun = { input: EngineRunInput; threadId: string; turnId?: string; text: string; lastMessageId?: string; startedTools: Set<string>; completedTools: Set<string>; pendingImages: string[]; done: (result: EngineRunResult) => void; fail: (error: Error) => void; abort: () => void };
type ApprovalRequest = { runId: string; rpcId: string | number; kind: 'command' | 'file'; choices: string[] };

const CAPABILITIES = { resume: true, approvals: true, modelDiscovery: true, permissions: ['full-access', 'ask', 'read-only'] as const, nativeExtensions: true };
const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration', 'sleep']);

function toolName(item: Record<string, unknown>): string {
  const type = string(item.type) ?? 'tool';
  if (type === 'mcpToolCall') return [string(item.server), string(item.tool)].filter(Boolean).join('/') || type;
  if (type === 'dynamicToolCall') return [string(item.namespace), string(item.tool)].filter(Boolean).join('/') || type;
  if (type === 'collabAgentToolCall') return string(item.tool) ?? type;
  return type;
}

function toolSucceeded(item: Record<string, unknown>): boolean {
  if (['failed', 'declined', 'interrupted'].includes(string(item.status) ?? '')) return false;
  if (item.success === false) return false;
  if (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0) return false;
  if (item.type === 'mcpToolCall' && item.error != null) return false;
  if (item.type === 'imageGeneration' && item.failure != null) return false;
  return true;
}

export class CodexAdapter implements EngineAdapter {
  readonly id = 'codex' as const;
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private runs = new Map<string, ActiveRun>();
  private approvals = new Map<string, ApprovalRequest>();
  constructor(private readonly options: AdapterOptions) {}

  private async env(): Promise<NodeJS.ProcessEnv> {
    const profile = await prepareProfile(this.options, 'codex');
    return { ...stripProviderCredentials(), CODEX_HOME: profile };
  }

  private async command() { return engineCommand(this.options, 'codex'); }

  private async connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }

  private async start(): Promise<void> {
    const { file, prefix } = await this.command();
    const child = spawnEngine(file, [...prefix, 'app-server', '--stdio'], { env: await this.env(), stdin: 'pipe' });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.on('error', error => { if (this.child === child) this.close(error); });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.close(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}): ${stderr}`));
    });
    createInterface({ input: child.stdout! }).on('line', line => this.receive(line));
    await this.request('initialize', {
      clientInfo: { name: 'ciel', title: 'CIEL', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    }, 10000);
    this.notify('initialized', {});
  }

  private close(error: Error): void {
    if (this.child) this.child = undefined;
    this.ready = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    for (const run of this.runs.values()) run.fail(error);
    this.runs.clear();
    this.approvals.clear();
  }

  private send(message: unknown): void {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void { this.send({ method, params }); }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private receive(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = object(JSON.parse(line)); } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      const error = object(msg.error);
      if (msg.error) pending.reject(new Error(`Codex: ${string(error.message) ?? 'protocol error'}`));
      else pending.resolve(object(msg.result));
      return;
    }
    const method = string(msg.method);
    if (!method) return;
    const params = object(msg.params);
    if (msg.id !== undefined) { this.handleServerRequest(method, msg.id as string | number, params); return; }
    this.handleNotification(method, params);
  }

  private handleServerRequest(method: string, rpcId: string | number, params: Record<string, unknown>): void {
    const threadId = string(params.threadId);
    const run = threadId && this.runs.get(threadId);
    const kind = method === 'item/commandExecution/requestApproval' ? 'command'
      : method === 'item/fileChange/requestApproval' ? 'file' : undefined;
    if (!run || !kind) {
      this.send({ id: rpcId, error: { code: -32601, message: `CIEL cannot handle ${method}` } });
      return;
    }
    const id = `${run.input.runId}:${String(rpcId)}`;
    const choices = kind === 'command' ? ['accept', 'acceptForSession', 'decline', 'cancel'] : ['accept', 'acceptForSession', 'decline', 'cancel'];
    this.approvals.set(id, { runId: run.input.runId, rpcId, kind, choices });
    run.input.emit({
      type: 'approval', id,
      title: kind === 'command' ? 'Approve command' : 'Approve file change',
      description: string(params.reason) ?? string(params.command) ?? jsonSafe(params),
      choices,
    });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const threadId = string(params.threadId);
    const run = threadId && this.runs.get(threadId);
    if (!run) return;
    const item = object(params.item);
    const itemId = string(item.id) ?? string(params.itemId);
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      if (itemId && run.lastMessageId && itemId !== run.lastMessageId && run.text) {
        const separator = run.text.endsWith('\n\n') ? '' : run.text.endsWith('\n') ? '\n' : '\n\n';
        if (separator) { run.text += separator; run.input.emit({ type: 'text.delta', text: separator }); }
      }
      if (itemId) run.lastMessageId = itemId;
      run.text += params.delta;
      run.input.emit({ type: 'text.delta', text: params.delta, native: redactNative({ method, params }) });
    } else if (method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') {
      run.input.emit({ type: 'text.delta', text: params.delta, channel: 'reasoning', native: redactNative({ method, params }) });
    } else if (method === 'item/started') {
      if (TOOL_ITEMS.has(string(item.type) ?? '') && itemId && !run.startedTools.has(itemId)) {
        run.startedTools.add(itemId);
        const safeItem = item.type === 'imageGeneration' ? { ...item, result: item.result ? '[image data]' : null, savedPath: item.savedPath ? '[saved locally]' : null } : item;
        run.input.emit({ type: 'tool.started', id: itemId, name: toolName(item), input: jsonSafe(redactNative(safeItem)), native: redactNative({ method, params: { ...params, item: safeItem } }) });
      }
    } else if (method === 'item/completed') {
      if (TOOL_ITEMS.has(string(item.type) ?? '') && itemId && !run.completedTools.has(itemId)) {
        run.completedTools.add(itemId);
        if (item.type === 'imageGeneration') {
          const base64 = string(item.result);
          const savedPath = string(item.savedPath);
          if (toolSucceeded(item) && (base64 || savedPath)) run.input.emit({ type: 'image.generated', id: itemId, savedPath, base64 });
          if (toolSucceeded(item) && savedPath && existsSync(savedPath)) this.steerImage(run,savedPath);
          const safeItem = { ...item, result: base64 ? '[image data]' : null, savedPath: savedPath ? '[saved locally]' : null };
          run.input.emit({ type: 'tool.completed', id: itemId, output: jsonSafe(redactNative(safeItem)), success: toolSucceeded(item), native: redactNative({ method, params: { ...params, item: safeItem } }) });
        } else run.input.emit({ type: 'tool.completed', id: itemId, output: jsonSafe(redactNative(item)), success: toolSucceeded(item), native: redactNative({ method, params }) });
      }
    } else if (method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
      run.input.emit({ type: 'status', message: String(redactNative(params.delta)) });
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (run.turnId && string(turn.id) !== run.turnId) return;
      this.runs.delete(threadId!);
      for (const [id, approval] of this.approvals) if (approval.runId === run.input.runId) this.approvals.delete(id);
      if (turn.status === 'completed') run.done({ sessionId: threadId, text: run.text });
      else run.fail(new Error(String(redactNative(`Codex turn ${string(turn.status) ?? 'failed'}${object(turn.error).message ? `: ${String(object(turn.error).message)}` : ''}`))));
    } else if (method === 'warning' || method === 'configWarning') {
      run.input.emit({ type: 'status', message: String(redactNative(string(params.message) ?? jsonSafe(params))) });
    }
  }

  private steerImage(run:ActiveRun,path:string):void {
    if(!run.turnId){run.pendingImages.push(path);return;}
    if(run.input.signal.aborted||this.runs.get(run.threadId)!==run)return;
    void this.request('turn/steer',{threadId:run.threadId,expectedTurnId:run.turnId,input:[
      {type:'text',text:'The image you just generated is attached as visual input. Inspect it before answering the user; do not generate another image unless requested.'},
      {type:'localImage',path},
    ]},10000).catch(()=>{ /* A completed turn cannot be steered; the next turn receives the saved image. */ });
  }

  async status(): Promise<EngineStatus> {
    const base: EngineStatus = { id: 'codex', name: 'Codex', installed: false, authenticated: false, models: [], capabilities: { ...CAPABILITIES, permissions: [...CAPABILITIES.permissions] } };
    try {
      const { file, prefix } = await this.command();
      const version = await capture(file, [...prefix, '--version'], { env: await this.env(), timeoutMs: 3000 });
      if (version.code !== 0) throw new Error('Codex CLI unavailable');
      base.installed = true;
      base.version = version.stdout.trim();
      await this.connect();
      base.protocolHealthy = true;
      const account = await this.request('account/read', { refreshToken: false }, 5000);
      const details = object(account.account);
      base.authMode = string(details.type) ?? 'signed out';
      base.authenticated = details.type === 'chatgpt';
      base.accountLabel = string(details.email) ?? undefined;
      const models: Record<string, unknown> = await this.request('model/list', { limit: 100 }, 5000).catch(() => ({}));
      base.models = (Array.isArray(models.data) ? models.data : []).map((value: unknown): ModelInfo | undefined => {
        const model = object(value);
        const id = string(model.id) ?? string(model.model);
        if (!id) return undefined;
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.map(value => string(object(value).reasoningEffort) ?? string(value)).filter((value): value is string => !!value)
          : undefined;
        return { id, name: string(model.displayName) ?? id, isDefault: model.isDefault === true,
          ...(efforts?.length ? { efforts } : {}), ...(string(model.defaultReasoningEffort) ? { defaultEffort: string(model.defaultReasoningEffort) } : {}) };
      }).filter((value: ModelInfo | undefined): value is ModelInfo => !!value);
      if (!base.authenticated) base.error = details.type && details.type !== 'chatgpt'
        ? `Codex is signed in using ${String(details.type)}; CIEL requires ChatGPT subscription login`
        : 'Sign in to Codex with ChatGPT';
    } catch (error) { base.error = describeError(error); }
    return base;
  }

  async login(): Promise<AuthFlow> {
    try {
      await this.connect();
      const result = await this.request('account/login/start', { type: 'chatgptDeviceCode' }, 10000);
      const url = string(result.verificationUrl);
      const userCode = string(result.userCode);
      if (!url || !userCode) return { status: 'unavailable', message: 'Codex did not provide a ChatGPT device code' };
      return { status: 'pending', url, userCode, message: 'Open the link and enter the code to sign in with ChatGPT' };
    } catch (error) { return { status: 'unavailable', message: describeError(error) }; }
  }

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    await this.connect();
    const account = object((await this.request('account/read', { refreshToken: false }, 5000)).account);
    if (account.type !== 'chatgpt') throw new Error('Codex requires ChatGPT subscription login in the CIEL profile');
    const sandbox = input.permission === 'full-access' ? 'danger-full-access'
      : input.permission === 'read-only' ? 'read-only' : 'workspace-write';
    const approvalPolicy = input.permission === 'ask' ? 'on-request' : 'never';
    const mcp = await projectedMcp(this.options, 'codex');
    const config = mcp.length ? { mcp_servers: Object.fromEntries(mcp.map(server => [server.name, {
      command: server.command, args: server.args, env: resolveMcpEnvironment(server.env),
    }])) } : undefined;
    const threadResponse = input.sessionId
      ? await this.request('thread/resume', { threadId: input.sessionId, cwd: input.cwd, model: input.model ?? null, sandbox, approvalPolicy, ...(config ? { config } : {}) }, 15000)
      : await this.request('thread/start', { cwd: input.cwd, model: input.model ?? null, sandbox, approvalPolicy, serviceName: 'ciel', ...(config ? { config } : {}) }, 15000);
    const threadId = string(object(threadResponse.thread).id);
    if (!threadId) throw new Error('Codex did not return a native thread ID');
    input.emit({ type: 'session', sessionId: threadId });
    if (input.signal.aborted) throw new Error('Codex turn interrupted');
    let complete!: (result: EngineRunResult) => void;
    let fail!: (error: Error) => void;
    const result = new Promise<EngineRunResult>((resolve, reject) => { complete = resolve; fail = reject; });
    const active: ActiveRun = {
      input, threadId, text: '', startedTools: new Set(), completedTools: new Set(), pendingImages: [], done: complete, fail,
      abort: () => { if (active.turnId) void this.request('turn/interrupt', { threadId, turnId: active.turnId }, 5000).catch(() => {}); },
    };
    this.runs.set(threadId, active);
    input.signal.addEventListener('abort', active.abort, { once: true });
    try {
      const started = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt }, ...(input.localImages?.length ? [
          {type:'text',text:'The following images are attached to this CIEL conversation. Inspect them when relevant to the user request.'},
          ...input.localImages.map(path=>({type:'localImage',path})),
        ] : [])],
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      }, 30000);
      active.turnId = string(object(started.turn).id);
      if (!active.turnId) throw new Error('Codex did not return a native turn ID');
      for(const imagePath of active.pendingImages.splice(0))this.steerImage(active,imagePath);
      if (input.signal.aborted) active.abort();
      return await result;
    } catch (error) {
      this.runs.delete(threadId);
      throw error;
    } finally { input.signal.removeEventListener('abort', active.abort); }
  }

  async steer(runId:string,prompt:string):Promise<void> {
    const run=[...this.runs.values()].find(active=>active.input.runId===runId);
    if(!run?.turnId||run.input.signal.aborted)throw new Error('Codex turn is not ready for steering; queue the message instead');
    await this.request('turn/steer',{threadId:run.threadId,expectedTurnId:run.turnId,input:[{type:'text',text:prompt}]},10000);
  }

  async approve(runId: string, approvalId: string, decision: string): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.runId !== runId) throw new Error('Codex approval is no longer pending');
    if (!approval.choices.includes(decision)) throw new Error(`Unsupported Codex approval decision: ${decision}`);
    this.approvals.delete(approvalId);
    this.send({ id: approval.rpcId, result: { decision } });
  }

  async extensions() { return discoverExtensions(this.options, 'codex'); }

  async dispose(): Promise<void> {
    const child = this.child;
    this.close(new Error('Codex adapter disposed'));
    if (child) await stopEngine(child);
  }
}
