import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { AdapterOptions, EngineId, NativeExtension } from '@ciel/contracts';

export function profilePath(options: AdapterOptions, engine: EngineId): string {
  return join(options.dataDir, 'engines', engine);
}

export async function prepareProfile(options: AdapterOptions, engine: EngineId): Promise<string> {
  const path = profilePath(options, engine);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

export function stripProviderCredentials(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$|OPENROUTER_API_KEY$|OPENCODE_SERVER_)/.test(key)) delete env[key];
  }
  return env;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function spawnEngine(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: 'pipe' | 'ignore' } = {}): ChildProcess {
  const stdin = options.stdin ?? 'ignore';
  const supervisor = [
    join(dirname(process.argv[1] ?? ''), 'engine-supervisor.cjs'),
    join(process.cwd(), 'dist', 'host', 'engine-supervisor.cjs'),
    join(process.cwd(), 'packages', 'adapters', 'src', 'engine-supervisor.cjs'),
  ].find(existsSync);
  if (!supervisor) throw new Error('CIEL native supervisor is missing from the installation');
  return spawn(process.execPath, [supervisor], {
    cwd: options.cwd,
    env: { ...options.env, CIEL_SUPERVISOR_SPEC: JSON.stringify({ file, args, cwd: options.cwd, stdin }) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

export async function stopEngine(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let fallback: NodeJS.Timeout | undefined;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); if (fallback) clearTimeout(fallback); resolve(); };
    child.once('close', finish);
    child.stdin?.end();
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
        const killer = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill('SIGKILL'));
      } else child.kill('SIGTERM');
      fallback = setTimeout(() => { if (!done) { child.kill('SIGKILL'); done = true; reject(new Error('Native engine did not stop after forced termination')); } }, process.platform === 'win32' ? 2000 : 5000);
      fallback.unref();
    }, timeoutMs);
    timer.unref();
  });
}

export async function capture(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnEngine(binary, args, { cwd: options.cwd, env: options.env, stdin: 'ignore' });
    } catch (error) { reject(error); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    let forcedError: Error | undefined;
    const timer = setTimeout(() => {
      forcedError = new Error(`${binary} timed out`);
      void stopEngine(child).catch(error => finish(error));
    }, options.timeoutMs ?? 5000);
    timer.unref();
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    child.on('error', error => finish(error));
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > maxBytes && !forcedError) { forcedError = new Error(`${binary} output too large`); void stopEngine(child).catch(error => finish(error)); }
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > maxBytes && !forcedError) { forcedError = new Error(`${binary} output too large`); void stopEngine(child).catch(error => finish(error)); }
    });
    child.on('close', code => finish(forcedError, code ?? 1));
  });
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function jsonSafe(value: unknown, max = 4000): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
  return serialized.length > max ? `${serialized.slice(0, max)}…` : serialized;
}

/** Windows npm shims require a shell. Resolve the published JS entrypoint instead. */
export async function engineCommand(options: AdapterOptions, engine: EngineId): Promise<{ file: string; prefix: string[] }> {
  const packageEntry: Record<EngineId, string> = {
    codex: join('@openai', 'codex', 'bin', 'codex.js'),
    claude: join('@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    opencode: join('opencode-ai', 'bin', 'opencode.exe'),
  };
  const managed = join(options.dataDir, 'runtimes', engine, 'current', 'node_modules', packageEntry[engine]);
  if (!options.binaries?.[engine]) {
    try {
      await access(managed);
      return engine === 'codex' ? { file: process.execPath, prefix: [managed] } : { file: managed, prefix: [] };
    } catch { /* Fall through to PATH. */ }
  }
  let binary = options.binaries?.[engine] ?? engine;
  if (/\.[cm]?js$/i.test(binary)) return { file: process.execPath, prefix: [binary] };
  if (process.platform === 'win32' && !/[\\/]/.test(binary)) {
    const paths = (process.env.PATH ?? '').split(delimiter);
    for (const path of paths) {
      for (const extension of ['.exe', '.cmd', '.ps1']) {
        const candidate = join(path, `${binary}${extension}`);
        try { await access(candidate); binary = candidate; break; } catch { /* Continue. */ }
      }
      if (/[\\/]/.test(binary)) break;
    }
  }
  if (process.platform !== 'win32' || !/\.(?:cmd|ps1)$/i.test(binary)) return { file: binary, prefix: [] };
  const root = dirname(binary);
  const entry = join(root, 'node_modules', packageEntry[engine]);
  try { await access(entry); }
  catch { throw new Error(`${engine} Windows launcher is present, but its native package entrypoint was not found`); }
  return engine === 'codex' ? { file: process.execPath, prefix: [entry] } : { file: entry, prefix: [] };
}

export function redactNative(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map(item => redactNative(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /token|secret|password|api.?key|authorization|cookie|credential|authurl/i.test(key)
        ? '[redacted]' : redactNative(item, depth + 1),
    ]));
  }
  if (typeof value === 'string') return value.replace(/(?:sk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/gi, '[redacted]');
  return value;
}

export interface ProjectedMcp { id: string; name: string; command: string; args: string[]; env: Record<string, string> }
export async function projectedMcp(options: AdapterOptions, engine: EngineId): Promise<ProjectedMcp[]> {
  const file = join(profilePath(options, engine), 'ciel-projection', 'ciel-projection.json');
  let content: string;
  try { content = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const projection = object(JSON.parse(content));
  if (projection.version !== 1 || !Array.isArray(projection.mcp)) throw new Error('CIEL native MCP projection is invalid');
  return projection.mcp.map(value => {
    const item = object(value);
    const env = object(item.env);
    if (typeof item.name !== 'string' || typeof item.command !== 'string' || !Array.isArray(item.args) || item.args.some(arg => typeof arg !== 'string') || Object.values(env).some(v => typeof v !== 'string')) throw new Error('CIEL native MCP projection is invalid');
    return { id: string(item.id) ?? '', name: item.name, command: item.command, args: item.args as string[], env: env as Record<string, string> };
  });
}

export function resolveMcpEnvironment(mapping: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [target, source] of Object.entries(mapping)) {
    const value = process.env[source];
    if (value === undefined) throw new Error(`MCP environment variable ${source} is missing`);
    values[target] = value;
  }
  return values;
}

export async function discoverExtensions(options: AdapterOptions, engine: EngineId): Promise<NativeExtension[]> {
  const profile = profilePath(options, engine);
  const skills = engine === 'opencode' ? join(profile, 'config', 'opencode', 'skills') : join(profile, 'skills');
  const result: NativeExtension[] = [];
  try {
    for (const entry of await readdir(skills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(skills, entry.name, 'SKILL.md');
      try { await access(file); result.push({ id: `skill:${entry.name}`, name: entry.name, kind: 'skill', enabled: true, source: file }); }
      catch { /* Not a native skill. */ }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const server of await projectedMcp(options, engine)) result.push({ id: `mcp:${server.name}`, name: server.name, kind: 'mcp', enabled: true, source: 'CIEL library' });
  return result;
}
