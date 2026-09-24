import { type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterOptions, AuthFlow, EngineAdapter, EngineRunInput, EngineRunResult, EngineStatus } from '@ciel/contracts';
import { ClaudePermissionBridge } from './claude-bridge.js';
import { capture, describeError, discoverExtensions, engineCommand, jsonSafe, object, prepareProfile, projectedMcp, redactNative, resolveMcpEnvironment, spawnEngine, stopEngine, string, stripProviderCredentials } from './common.js';

const CAPABILITIES = { resume: true, approvals: true, modelDiscovery: false, permissions: ['full-access', 'ask', 'read-only'] as const, nativeExtensions: true };

export class ClaudeAdapter implements EngineAdapter {
  readonly id = 'claude' as const;
  private active = new Map<string, { process: ChildProcess; bridge?: ClaudePermissionBridge }>();
  private loginChild?: ChildProcess;

  constructor(private readonly options: AdapterOptions) {}

  private async env(): Promise<NodeJS.ProcessEnv> {
    const profile = await prepareProfile(this.options, 'claude');
    const env = stripProviderCredentials();
    for (const key of ['ANTHROPIC_PROFILE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY']) delete env[key];
    return { ...env, CLAUDE_CONFIG_DIR: profile };
  }

  async status(): Promise<EngineStatus> {
    const base: EngineStatus = { id: 'claude', name: 'Claude Code', installed: false, authenticated: false, models: [], capabilities: { ...CAPABILITIES, permissions: [...CAPABILITIES.permissions] } };
    try {
      const command = await engineCommand(this.options, 'claude');
      const env = await this.env();
      const version = await capture(command.file, [...command.prefix, '--version'], { env, timeoutMs: 3000 });
      if (version.code !== 0) throw new Error('Claude Code CLI unavailable');
      base.installed = true;
      base.version = version.stdout.trim();
      const auth = await capture(command.file, [...command.prefix, 'auth', 'status'], { env, timeoutMs: 5000 });
      const details = object(JSON.parse(auth.stdout));
      if (typeof details.loggedIn !== 'boolean') throw new Error('Claude auth status did not return a valid protocol response');
      base.protocolHealthy = true;
      if (auth.code !== 0) { base.error = 'Sign in to Claude Code with a Claude subscription'; return base; }
      base.authMode = string(details.authMethod) ?? 'unknown';
      base.accountLabel = string(details.email);
      base.authenticated = details.loggedIn === true && details.authMethod === 'claude.ai' && details.apiProvider === 'firstParty';
      if (!base.authenticated) base.error = 'CIEL requires Claude subscription login (claude.ai), not Console or API credentials';
    } catch (error) { base.error = describeError(error); }
    return base;
  }

  async login(): Promise<AuthFlow> {
    try {
      const command = await engineCommand(this.options, 'claude');
      const env = await this.env();
      const child = spawnEngine(command.file, [...command.prefix, 'auth', 'login', '--claudeai'], { env, stdin: 'pipe' });
      this.loginChild = child;
      let output = '';
      const collect = (chunk: Buffer) => { output = (output + String(chunk)).slice(-12000); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('exit', () => { if (this.loginChild === child) this.loginChild = undefined; });
      await new Promise(resolve => { const timer = setTimeout(resolve, 1800); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(undefined); }); });
      const url = output.match(/https:\/\/[^\s\x1b<>"']+/)?.[0];
      if (child.exitCode !== null && child.exitCode !== 0) return { status: 'unavailable', message: 'Claude Code could not start subscription sign-in' };
      // Claude's callback is normally localhost on the execution host. Do not offer
      // that URL as a remote browser link, because it would call the viewing host.
      let usableUrl: string | undefined;
      if (url) {
        try {
          const redirect = new URL(url).searchParams.get('redirect_uri');
          if (!redirect || !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(redirect)) usableUrl = url;
        } catch { /* Keep the host-side browser flow. */ }
      }
      return { status: 'pending', ...(usableUrl ? { url: usableUrl } : {}), message: 'Complete Claude subscription sign-in in a browser on the execution host' };
    } catch (error) { return { status: 'unavailable', message: describeError(error) }; }
  }

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    const status = await this.status();
    if (!status.installed) throw new Error(status.error ?? 'Claude Code is not installed');
    if (!status.authenticated) throw new Error(status.error ?? 'Claude subscription login is unavailable');
    const command = await engineCommand(this.options, 'claude');
    const profile = await prepareProfile(this.options, 'claude');
    const args = [
      ...command.prefix, '-p', input.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', input.permission === 'full-access' ? 'bypassPermissions' : input.permission === 'read-only' ? 'plan' : 'default',
    ];
    if (input.sessionId) args.push('--resume', input.sessionId);
    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort);
    let bridge: ClaudePermissionBridge | undefined;
    let mcpConfigFile: string | undefined;
    const mcpServers: Record<string, unknown> = {};
    for (const server of await projectedMcp(this.options, 'claude')) {
      resolveMcpEnvironment(server.env);
      mcpServers[server.name] = { command: server.command, args: server.args,
        env: Object.fromEntries(Object.entries(server.env).map(([target, source]) => [target, `\${${source}}`])) };
    }
    if (input.permission === 'ask') {
      bridge = new ClaudePermissionBridge(input, profile);
      const config = await bridge.start();
      Object.assign(mcpServers, object(object(JSON.parse(config.config)).mcpServers));
      args.push('--permission-prompt-tool', config.tool);
    }
    if (Object.keys(mcpServers).length) {
      mcpConfigFile = join(profile, `ciel-mcp-${randomUUID()}.json`);
      await writeFile(mcpConfigFile, JSON.stringify({ mcpServers }), { mode: 0o600 });
      args.push('--mcp-config', mcpConfigFile);
    }
    if (input.signal.aborted) { await bridge?.close(); if (mcpConfigFile) await rm(mcpConfigFile, { force: true }); throw new Error('Claude turn interrupted'); }
    const child = spawnEngine(command.file, args, { cwd: input.cwd, env: await this.env(), stdin: 'ignore' });
    this.active.set(input.runId, { process: child, bridge });
    const abort = () => { void stopEngine(child).catch(() => {}); };
    input.signal.addEventListener('abort', abort, { once: true });
    let finalText = '';
    let streamedText = '';
    let sessionId = input.sessionId;
    let resultError: string | undefined;
    let stderr = '';
    const startedTools = new Set<string>();
    const completedTools = new Set<string>();
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    createInterface({ input: child.stdout! }).on('line', line => {
      let msg: Record<string, unknown>;
      try { msg = object(JSON.parse(line)); } catch { return; }
      const foundSession = string(msg.session_id);
      if (foundSession && foundSession !== sessionId) { sessionId = foundSession; input.emit({ type: 'session', sessionId }); }
      if (msg.type === 'stream_event') {
        const event = object(msg.event);
        const delta = object(event.delta);
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          streamedText += delta.text;
          input.emit({ type: 'text.delta', text: delta.text, native: redactNative(msg) });
        }
      } else if (msg.type === 'assistant') {
        const message = object(msg.message);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          const item = object(block);
          const id = string(item.id);
          if (item.type === 'tool_use' && id && !startedTools.has(id)) {
            startedTools.add(id);
            input.emit({ type: 'tool.started', id, name: string(item.name) ?? 'tool', input: jsonSafe(redactNative(item.input)), native: redactNative(msg) });
          }
        }
      } else if (msg.type === 'user') {
        const message = object(msg.message);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          const item = object(block);
          const id = string(item.tool_use_id);
          if (item.type === 'tool_result' && id && !completedTools.has(id)) {
            completedTools.add(id);
            input.emit({ type: 'tool.completed', id, output: jsonSafe(redactNative(item.content)), success: item.is_error !== true, native: redactNative(msg) });
          }
        }
      } else if (msg.type === 'result') {
        finalText = string(msg.result) ?? '';
        if (msg.is_error === true) resultError = string(msg.error) ?? (finalText || 'Claude Code failed');
      } else if (msg.type === 'system' && msg.subtype === 'permission_denied') {
        input.emit({ type: 'status', message: 'Claude Code denied a tool permission', native: redactNative(msg) });
      }
    });
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', value => resolve(value ?? 1));
      });
      if (input.signal.aborted) throw new Error('Claude turn interrupted');
      if (code !== 0 || resultError) throw new Error(String(redactNative(resultError ?? `Claude Code exited with code ${code}: ${stderr}`)));
      if (!sessionId) throw new Error('Claude Code produced no native session ID');
      if (finalText && !streamedText) input.emit({ type: 'text.delta', text: finalText });
      return { sessionId, text: finalText || streamedText };
    } finally {
      input.signal.removeEventListener('abort', abort);
      this.active.delete(input.runId);
      await bridge?.close();
      if (mcpConfigFile) await rm(mcpConfigFile, { force: true });
    }
  }

  async approve(runId: string, approvalId: string, decision: string): Promise<void> {
    const bridge = this.active.get(runId)?.bridge;
    if (!bridge?.approve(approvalId, decision)) throw new Error('Claude approval is no longer pending');
  }

  async extensions() { return discoverExtensions(this.options, 'claude'); }

  async dispose(): Promise<void> {
    if (this.loginChild) await stopEngine(this.loginChild);
    for (const run of this.active.values()) { await stopEngine(run.process); await run.bridge?.close(); }
    this.active.clear();
  }
}
