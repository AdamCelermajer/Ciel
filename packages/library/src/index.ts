import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EngineId, LibraryItem } from '@ciel/contracts';
import { projectLibraryToEngine, validateLibraryItem, type ProjectionReport } from './projection.js';
export { parseMcp, validateLibraryItem, type ProjectionReport, type NativeProjection, type McpProjection } from './projection.js';

const itemSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(''),
  kind: z.enum(['instruction', 'memory', 'skill', 'mcp']), content: z.string().max(200000),
  engines: z.array(z.enum(['codex', 'claude', 'opencode'])).min(1), enabled: z.boolean().default(true), updatedAt: z.string(),
});
export class LibraryStore {
  private file: string;
  private items: LibraryItem[];
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'library.json');
    try { this.items = z.array(itemSchema).parse(JSON.parse(readFileSync(this.file, 'utf8'))); this.items.forEach(validateLibraryItem); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Shared library is unreadable; preserve the file and restore a valid export.', { cause: error }); this.items = []; }
  }
  private save() {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  list(): LibraryItem[] { return structuredClone(this.items); }
  create(input: unknown): LibraryItem {
    const item = itemSchema.parse({ ...(input as object), id: randomUUID(), updatedAt: new Date().toISOString() });
    validateLibraryItem(item);
    this.items.push(item); this.save(); return structuredClone(item);
  }
  update(id: string, input: unknown): LibraryItem {
    const index = this.items.findIndex(x => x.id === id);
    if (index < 0) throw new Error('Library item not found');
    const item = itemSchema.parse({ ...this.items[index], ...(input as object), id, updatedAt: new Date().toISOString() });
    validateLibraryItem(item);
    this.items[index] = item; this.save(); return structuredClone(item);
  }
  remove(id: string): boolean {
    const before = this.items.length; this.items = this.items.filter(x => x.id !== id); this.save(); return before !== this.items.length;
  }
  export(): { version: 1; items: LibraryItem[] } { this.items.forEach(validateLibraryItem); return { version: 1, items: this.list() }; }
  import(input: unknown): LibraryItem[] {
    const payload = z.object({ version: z.literal(1), items: z.array(itemSchema).max(500) }).parse(input);
    payload.items.forEach(validateLibraryItem);
    const added = payload.items.map(item => ({ ...item, id: randomUUID(), updatedAt: new Date().toISOString() }));
    this.items.push(...added); this.save(); return structuredClone(added);
  }
  renderContext(engine: EngineId): string {
    return this.items.filter(x => x.enabled && x.engines.includes(engine) && (x.kind === 'instruction' || x.kind === 'memory'))
      .map(x => `## ${x.kind}: ${x.name}\n${x.content}`).join('\n\n').slice(0, 80000);
  }
  async projectToEngine(engine: EngineId, dataDir: string): Promise<ProjectionReport> {
    return projectLibraryToEngine(this.items, engine, dataDir);
  }
}
