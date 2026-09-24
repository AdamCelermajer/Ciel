import { expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from '../src/index.js';

test('projects native skills and credential-free MCP without overwriting local edits', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ciel-library-'));
  const library = new LibraryStore(dataDir);
  const skill = library.create({ name: 'Review', description: 'Review changes', kind: 'skill', content: 'Review the diff.', engines: ['codex'], enabled: true });
  const mcp = library.create({ name: 'Local tool', description: '', kind: 'mcp', content: JSON.stringify({ command: 'node', args: ['tool.js'], env: { TOOL_TOKEN: '${LOCAL_TOOL_TOKEN}' } }), engines: ['codex'], enabled: true });
  const report = await library.projectToEngine('codex', dataDir);
  expect(report.rejected).toEqual([]);
  expect(report.applied).toEqual([skill.id, mcp.id]);
  const file = join(dataDir, 'engines', 'codex', 'skills', `ciel-${skill.id}`, 'SKILL.md');
  expect(await readFile(file, 'utf8')).toContain('Review the diff.');
  const projection = JSON.parse(await readFile(join(dataDir, 'engines', 'codex', 'ciel-projection', 'ciel-projection.json'), 'utf8'));
  expect(projection.mcp[0].env).toEqual({ TOOL_TOKEN: 'LOCAL_TOOL_TOKEN' });
  await writeFile(file, 'personal edit');
  const second = await library.projectToEngine('codex', dataDir);
  expect(second.rejected).toEqual([{ id: skill.id, reason: 'Existing native skill was changed outside CIEL; refusing to overwrite it' }]);
  expect(await readFile(file, 'utf8')).toBe('personal edit');
});

test('rejects literal credentials on create and import', async () => {
  const library = new LibraryStore(await mkdtemp(join(tmpdir(), 'ciel-library-')));
  expect(() => library.create({ name: 'Unsafe', kind: 'mcp', content: JSON.stringify({ command: 'node', env: { TOKEN: 'sk-ant-abcdefghijklmnopqrstuvwxyz' } }), engines: ['claude'] })).toThrow();
  expect(() => library.import({ version: 1, items: [{ id: 'c0a80108-b866-4b9d-b4ab-57b489f9310e', name: 'Unsafe', kind: 'instruction', content: 'api_key = 123456789abc', engines: ['codex'], enabled: true, updatedAt: 'today' }] })).toThrow();
});
