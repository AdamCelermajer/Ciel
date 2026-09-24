import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CielUpdater, compareVersions, newestLinuxRelease } from '../src/update.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('local CIEL release detection', () => {
  it('chooses only a newer Linux tarball by version', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ciel-updates-'));
    directories.push(directory);
    for (const name of ['ciel-0.1.0-linux-x64.tar.gz', 'ciel-0.1.2-linux-x64.tar.gz', 'ciel-0.2.0-linux-x64.tar.gz', 'ciel-9.9.9-windows-x64.zip']) await writeFile(path.join(directory, name), 'fixture');
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect((await newestLinuxRelease(directory, '0.1.1'))?.version).toBe('0.2.0');
    expect(await newestLinuxRelease(directory, '0.2.0')).toBeUndefined();
  });
  it('refuses to self-update a development checkout', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ciel-updates-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'ciel-0.2.0-linux-x64.tar.gz'), 'fixture');
    const updater = new CielUpdater(directory, 4317, () => directory, () => false);
    const status = await updater.status();
    expect(status.available).toBe(true);
    expect(status.supported).toBe(false);
    await expect(updater.apply()).rejects.toThrow('cannot update itself');
  });
});
