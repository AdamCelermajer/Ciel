import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineId, LibraryItem } from '@ciel/contracts';

export interface McpProjection {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Target environment variable name to host environment variable name. No values are serialized. */
  env: Record<string, string>;
}
export interface NativeProjection { version: 1; mcp: McpProjection[] }
export interface ProjectionReport { applied: string[]; rejected: { id: string; reason: string }[] }

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const credential = /(?:sk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{12,}|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?(?!\$\{)[^\s"',}]{8,})/i;

/** Shared-library files and exports must never contain credential values. */
export function validateLibraryItem(item: LibraryItem): void {
  if (credential.test(item.content)) throw new Error(`Library item ${item.name} contains a credential-like value; use an environment variable reference`);
  if (item.kind === 'mcp') parseMcp(item);
}

export function parseMcp(item: LibraryItem): McpProjection {
  let raw: unknown;
  try { raw = JSON.parse(item.content); } catch { throw new Error(`MCP item ${item.name} must contain a JSON object`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`MCP item ${item.name} must contain a JSON object`);
  const config = raw as Record<string, unknown>;
  if (typeof config.command !== 'string' || !config.command.trim()) throw new Error(`MCP item ${item.name} requires command`);
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) throw new Error(`MCP item ${item.name} args must be strings`);
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) throw new Error(`MCP item ${item.name} env must be an object`);
  for (const key of Object.keys(config)) if (!['command', 'args', 'env'].includes(key)) throw new Error(`MCP item ${item.name} has unsupported field ${key}`);
  const env: Record<string, string> = {};
  for (const [target, value] of Object.entries((config.env ?? {}) as Record<string, unknown>)) {
    if (!envName.test(target) || typeof value !== 'string' || !ref.test(value)) throw new Error(`MCP item ${item.name} env values must be references like \${VAR_NAME}`);
    env[target] = ref.exec(value)![1];
  }
  return { id: item.id, name: `ciel_${item.id.replaceAll('-', '_')}`, command: config.command, args: (config.args ?? []) as string[], env };
}

function skillRoot(engine: EngineId, dataDir: string): string {
  const profile = join(dataDir, 'engines', engine);
  return engine === 'opencode' ? join(profile, 'config', 'opencode', 'skills') : join(profile, 'skills');
}

function skillText(item: LibraryItem): string {
  const content = item.content.trim();
  if (/^---\s*\n/.test(content)) return `${content}\n`;
  const name = `ciel-${item.id}`;
  const description = (item.description || item.name).replace(/[\r\n]+/g, ' ').replaceAll('"', '\\"');
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${content}\n`;
}

function hash(content: string): string { return createHash('sha256').update(content).digest('hex'); }

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}

export async function projectLibraryToEngine(items: LibraryItem[], engine: EngineId, dataDir: string): Promise<ProjectionReport> {
  const profile = join(dataDir, 'engines', engine);
  const stateDir = join(profile, 'ciel-projection');
  const skills = skillRoot(engine, dataDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(skills, { recursive: true, mode: 0o700 });
  const manifestFile = join(stateDir, 'manifest.json');
  let old: Record<string, string> = {};
  try { old = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, string>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('CIEL skill projection manifest is unreadable', { cause: error }); }
  const next: Record<string, string> = {};
  const report: ProjectionReport = { applied: [], rejected: [] };
  const mcp: McpProjection[] = [];
  for (const item of items.filter(value => value.enabled && value.engines.includes(engine))) {
    try {
      validateLibraryItem(item);
      if (item.kind === 'mcp') {
        mcp.push(parseMcp(item));
      } else if (item.kind === 'skill') {
        const file = join(skills, `ciel-${item.id}`, 'SKILL.md');
        const content = skillText(item);
        let current: string | undefined;
        try { current = await readFile(file, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (current !== undefined && (!old[item.id] || hash(current) !== old[item.id])) throw new Error('Existing native skill was changed outside CIEL; refusing to overwrite it');
        await mkdir(join(skills, `ciel-${item.id}`), { recursive: true, mode: 0o700 });
        await writeFile(file, content, { mode: 0o600 });
        next[item.id] = hash(content);
      }
      report.applied.push(item.id);
    } catch (error) {
      if (item.kind === 'skill' && old[item.id]) next[item.id] = old[item.id];
      report.rejected.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [id, oldHash] of Object.entries(old)) {
    if (next[id]) continue;
    const dir = join(skills, `ciel-${id}`);
    let current: string;
    try { current = await readFile(join(dir, 'SKILL.md'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (hash(current) !== oldHash) { report.rejected.push({ id, reason: 'Former native skill was changed outside CIEL; refusing to delete it' }); next[id] = oldHash; continue; }
    await rm(dir, { recursive: true });
  }
  await atomicJson(manifestFile, next);
  await atomicJson(join(stateDir, 'ciel-projection.json'), { version: 1, mcp } satisfies NativeProjection);
  return report;
}
