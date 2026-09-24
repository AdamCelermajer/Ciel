import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createPatch } from 'diff';
import ignore from 'ignore';
import type { ChangeSet, FileChange } from '@ciel/contracts';

const exec = promisify(execFile);
const MAX_FILES = 10000, MAX_TEXT = 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024;
interface FileState { hash: string; stamp?: string; text?: string; binary: boolean; truncated: boolean }
export interface WorkspaceSnapshot { files: Map<string, FileState>; warnings: string[]; complete?: boolean; unknown?: Set<string> }

async function inventory(root: string): Promise<{ names: string[]; capped: boolean }> {
  try {
    const { stdout } = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const names = [...new Set(stdout.split('\0').filter(Boolean))].sort();
    return { names: names.slice(0, MAX_FILES), capped: names.length > MAX_FILES };
  } catch {
    const rules = ignore().add(['.git/', 'node_modules/', 'dist/', 'build/', '.ciel/', '.venv/', 'coverage/']);
    try { rules.add(await readFile(path.join(root, '.gitignore'), 'utf8')); } catch { /* optional */ }
    const names: string[] = []; let capped = false;
    const visit = async (relative: string) => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        if (names.length >= MAX_FILES) { capped = true; return; }
        const name = path.posix.join(relative, entry.name);
        if (entry.isSymbolicLink() || rules.ignores(name + (entry.isDirectory() ? '/' : ''))) continue;
        if (entry.isDirectory()) await visit(name); else if (entry.isFile()) names.push(name);
      }
    };
    await visit('');
    return { names: names.sort(), capped };
  }
}

export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const root = await realpath(cwd), files = new Map<string, FileState>(), warnings: string[] = [], unknown = new Set<string>();
  const { names, capped } = await inventory(root);
  if (capped) warnings.push(`Snapshot limited to ${MAX_FILES} files.`);
  let total = 0;
  for (const name of names) {
    const absolute = path.resolve(root, name);
    if (!absolute.startsWith(root + path.sep)) continue;
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const resolved = await realpath(absolute);
      if (!resolved.startsWith(root + path.sep)) { unknown.add(name); warnings.push(`Excluded linked path outside the project: ${name}.`); continue; }
      const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (info.size > MAX_TEXT || total + info.size > MAX_TOTAL) {
        files.set(name, { hash: `metadata:${stamp}`, stamp, binary: true, truncated: true });
        continue;
      }
      const buffer = await readFile(absolute); total += buffer.length;
      const binary = buffer.includes(0);
      files.set(name, { hash: createHash('sha256').update(buffer).digest('hex'), stamp, text: binary ? undefined : buffer.toString('utf8'), binary, truncated: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { warnings.push(`Could not snapshot ${name}.`); unknown.add(name); }
    }
  }
  if ([...files.values()].some(f => f.truncated)) warnings.push('Large files are compared using metadata; their contents are not stored.');
  return { files, warnings, complete: !capped, unknown };
}

export function compareSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, runId: string): ChangeSet {
  const files: FileChange[] = [];
  for (const name of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const a = before.files.get(name), b = after.files.get(name);
    if (before.unknown?.has(name) || after.unknown?.has(name) || (!a && before.complete === false) || (!b && after.complete === false)) continue;
    if (a?.hash === b?.hash) continue;
    if (a && b && (a.truncated || b.truncated) && a.stamp && a.stamp === b.stamp) continue;
    const change: FileChange = { path: name, kind: !a ? 'added' : !b ? 'deleted' : 'modified', additions: 0, deletions: 0, binary: Boolean(a?.binary || b?.binary), truncated: Boolean(a?.truncated || b?.truncated) };
    if (!change.binary && !change.truncated) {
      const patch = createPatch(name, a?.text ?? '', b?.text ?? '', 'before turn', 'after turn');
      const lines = patch.split('\n');
      change.additions = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
      change.deletions = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
      change.patch = patch.slice(0, 200000);
      if (patch.length > 200000) change.truncated = true;
    }
    files.push(change);
  }
  return { runId, files, capturedAt: new Date().toISOString(), warning: [...new Set([...before.warnings, ...after.warnings])].join(' ') || undefined };
}
