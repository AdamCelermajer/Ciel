import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, symlink, lstat, cp, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EngineId } from '@ciel/contracts';
import { createAdapters } from '@ciel/adapters';

const exec = promisify(execFile);
const PACKAGES: Record<EngineId, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai' };
export interface RuntimeState { engine: EngineId; installedVersion?: string; latestVersion?: string; state: 'idle' | 'checking' | 'installing' | 'ready' | 'failed'; message?: string }

export class RuntimeManager {
  private states = new Map<EngineId, RuntimeState>();
  private installing = new Set<EngineId>();
  constructor(private dataDir: string, private busy: (engine: EngineId) => boolean) {}
  async status(): Promise<RuntimeState[]> {
    return Promise.all((Object.keys(PACKAGES) as EngineId[]).map(async engine => {
      const state = this.states.get(engine) ?? { engine, state: 'idle' as const };
      try { state.installedVersion = JSON.parse(await readFile(path.join(this.dataDir, 'runtimes', engine, 'current', 'node_modules', PACKAGES[engine], 'package.json'), 'utf8')).version; } catch { /* uninstalled */ }
      return { ...state };
    }));
  }
  async check(engine: EngineId): Promise<RuntimeState> {
    if (this.states.get(engine)?.state === 'installing') return this.states.get(engine)!;
    const state: RuntimeState = { engine, state: 'checking' }; this.states.set(engine, state);
    try {
      const response = await fetch(`https://registry.npmjs.org/${PACKAGES[engine]}/latest`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Registry returned ${response.status}`);
      const meta = await response.json() as { version: string };
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(meta.version)) throw new Error('Invalid release version');
      state.latestVersion = meta.version; state.state = 'ready';
    } catch (error) { state.state = 'failed'; state.message = (error as Error).message; }
    return { ...state };
  }
  async install(engine: EngineId): Promise<RuntimeState> {
    if (this.installing.has(engine)) throw new Error('Installation is already running.');
    if (this.busy(engine)) throw new Error('Wait for this engine’s active sessions to finish before updating.');
    this.installing.add(engine);
    try { return await this.installRelease(engine); }
    finally { this.installing.delete(engine); }
  }
  private async installRelease(engine: EngineId): Promise<RuntimeState> {
    const release = await this.check(engine);
    if (!release.latestVersion) throw new Error(release.message ?? 'Could not check engine release');
    const state: RuntimeState = { ...release, state: 'installing', message: 'Downloading official runtime…' }; this.states.set(engine, state);
    const root = path.join(this.dataDir, 'runtimes', engine), stage = path.join(root, `v${release.latestVersion}-${Date.now()}`), current = path.join(root, 'current'), previous = path.join(root, 'previous');
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      // npm validates registry tarball integrity and installs the official native optional dependency.
      const npmCliCandidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js'), process.env.CIEL_NPM_CLI].filter(Boolean) as string[];
      const npmCli = npmCliCandidates.find(existsSync);
      const command = npmCli ? process.execPath : (process.platform === 'win32' ? '' : 'npm');
      if (!command) throw new Error('npm is required for engine setup. Install Node.js LTS with npm, then retry.');
      const args = [...(npmCli ? [npmCli] : []), 'install', '--prefix', stage, '--no-audit', '--no-fund', '--save-exact', `${PACKAGES[engine]}@${release.latestVersion}`];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, npm_config_update_notifier: 'false' } });
        let errors = ''; child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Engine installation failed (${code}). ${errors}`)));
        const timer = setTimeout(() => { child.kill(); reject(new Error('Engine installation timed out.')); }, 240000); timer.unref(); child.once('exit', () => clearTimeout(timer));
      });
      const packageDir = path.join(stage, 'node_modules', PACKAGES[engine]);
      const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
      if (typeof bin !== 'string') throw new Error('Runtime package has no executable.');
      const executable = path.resolve(packageDir, bin);
      if (!executable.startsWith(packageDir + path.sep)) throw new Error('Invalid executable path');
      await exec(executable.endsWith('.js') ? process.execPath : executable, [...(executable.endsWith('.js') ? [executable] : []), '--version'], { timeout: 20000, windowsHide: true });
      state.message = 'Checking native integration in a disposable profile…';
      const probeDir = await mkdtemp(path.join(root, 'probe-'));
      const adapter = createAdapters({ dataDir: probeDir, binaries: { [engine]: executable } })[engine];
      try {
        const status = await adapter.status();
        if (!status.installed || status.protocolHealthy !== true) throw new Error(`Native integration check failed: ${status.error ?? 'protocol unavailable'}`);
      } finally { await adapter.dispose(); await rm(probeDir, { recursive: true, force: true }); }
      if (this.busy(engine)) throw new Error('Engine became busy; update remains staged. Retry when idle.');
      const profile = path.join(this.dataDir, 'engines', engine);
      if (existsSync(profile)) {
        state.message = 'Saving native profile before activation…';
        const backup = path.join(this.dataDir, 'backups', `${engine}-${Date.now()}`);
        await mkdir(backup, { recursive: true, mode: 0o700 });
        await cp(profile, path.join(backup, 'profile'), { recursive: true, preserveTimestamps: true, dereference: false });
      }
      await rm(previous, { recursive: true, force: true });
      let hadCurrent = false;
      try { await lstat(current); hadCurrent = true; await rename(current, previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await symlink(stage, current, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (hadCurrent) await rename(previous, current); throw error; }
      state.state = 'ready'; state.installedVersion = release.latestVersion; state.message = 'Runtime installed; native integration verified.';
    } catch (error) { state.state = 'failed'; state.message = (error as Error).message; }
    return { ...state };
  }
}

export async function enableTailscale(port: number, preferred = 8443, oldCielPort?:number): Promise<{ url: string; port: number }> {
  const options = { timeout: 15000, windowsHide: true };
  const status = JSON.parse((await exec('tailscale', ['status', '--json'], options)).stdout);
  const name = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!name) throw new Error('Connect this computer to Tailscale first.');
  const serves = JSON.parse((await exec('tailscale', ['serve', 'status', '--json'], options)).stdout || '{}');
  let httpsPort = preferred;
  for (; httpsPort < preferred + 20; httpsPort++) {
    const used = serves.TCP?.[httpsPort];
    const existing = serves.Web?.[`${name}:${httpsPort}`]?.Handlers?.['/']?.Proxy;
    if ((!used&&!existing) || existing === `http://127.0.0.1:${port}` || (oldCielPort!==undefined&&existing===`http://127.0.0.1:${oldCielPort}`)) break;
  }
  if (httpsPort >= preferred + 20) throw new Error('No available CIEL HTTPS port in the configured range.');
  try { await exec('tailscale', ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`], options); }
  catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    const output = `${detail.stdout ?? ''}\n${detail.stderr ?? ''}`;
    const setupUrl = output.match(/https:\/\/login\.tailscale\.com\/f\/serve\?[^\s]+/)?.[0];
    if (setupUrl) throw new Error(`Enable private Tailscale Serve for this computer at ${setupUrl}, then retry.`);
    throw new Error(output.trim() || detail.message);
  }
  return { url: `https://${name}:${httpsPort}`, port: httpsPort };
}
