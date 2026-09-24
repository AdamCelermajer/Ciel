import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotWorkspace, compareSnapshots } from './index.js';
describe('turn changes', () => {
  it('does not label uncaptured files as additions or deletions', () => {
    const captured = { hash: 'same', text: 'content', binary: false, truncated: false };
    const before = { files: new Map([['before-only.txt', captured]]), complete: false, warnings: ['Inventory incomplete'] };
    const after = { files: new Map([['after-only.txt', captured]]), complete: false, warnings: ['Inventory incomplete'] };
    expect(compareSnapshots(before, after, 'limited').files).toEqual([]);
    expect(compareSnapshots(before, after, 'limited').warning).toContain('Inventory incomplete');
  });
  it('compares with the dirty starting state and captures create/delete without ignored files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ciel-changes-'));
    try {
      await writeFile(path.join(root, 'existing.txt'), 'already dirty\n');
      await writeFile(path.join(root, 'delete.txt'), 'old\n');
      await mkdir(path.join(root, 'node_modules'));
      await writeFile(path.join(root, 'node_modules', 'noise'), 'ignored');
      const before = await snapshotWorkspace(root);
      await writeFile(path.join(root, 'existing.txt'), 'already dirty\nnew\n');
      await writeFile(path.join(root, 'new.txt'), 'created\n');
      await rm(path.join(root, 'delete.txt'));
      const result = compareSnapshots(before, await snapshotWorkspace(root), 'run');
      expect(result.files.map(x => [x.path, x.kind])).toEqual([['delete.txt', 'deleted'], ['existing.txt', 'modified'], ['new.txt', 'added']]);
      expect(result.files[1]?.additions).toBe(1);
      expect(result.files[1]?.deletions).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
