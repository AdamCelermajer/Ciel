import { readdir, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { CielUpdateStatus } from '@ciel/contracts';
import { CIEL_VERSION } from '@ciel/contracts';

const execute = promisify(execFile);
const archivePattern = /^ciel-(\d+\.\d+\.\d+)-linux-x64\.tar\.gz$/;

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export async function newestLinuxRelease(directory: string, currentVersion: string): Promise<{ version: string; archive: string } | undefined> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let latest: { version: string; archive: string } | undefined;
  for (const name of entries) {
    const match = archivePattern.exec(name);
    if (!match || compareVersions(match[1]!, currentVersion) <= 0 || latest && compareVersions(match[1]!, latest.version) <= 0) continue;
    const archive = path.join(directory, name);
    if ((await stat(archive)).isFile()) latest = { version: match[1]!, archive };
  }
  return latest;
}

export class CielUpdater {
  private pending = false;
  private readonly installDirectory: string;
  private readonly helper: string;
  constructor(private dataDirectory: string, private port: number, private getDirectory: () => string | undefined, private hasActiveRuns: () => boolean) {
    this.installDirectory = path.join(dataDirectory, 'app');
    this.helper = path.join(dataDirectory, 'ciel-update');
  }
  private async supported(): Promise<boolean> {
    if (process.platform !== 'linux' || !existsSync(this.helper)) return false;
    try { return await realpath(process.cwd()) === await realpath(this.installDirectory); }
    catch { return false; }
  }
  private directory(): string { return this.getDirectory()?.trim() || process.env.CIEL_UPDATE_DIR || path.join(this.dataDirectory, 'updates'); }
  async status(): Promise<CielUpdateStatus> {
    const sourceDirectory = this.directory();
    const supported = await this.supported();
    const busy = this.pending || this.hasActiveRuns();
    try {
      const release = await newestLinuxRelease(sourceDirectory, CIEL_VERSION);
      return { currentVersion: CIEL_VERSION, latestVersion: release?.version, available: !!release, supported, busy, sourceDirectory };
    } catch (error) {
      return { currentVersion: CIEL_VERSION, available: false, supported, busy, sourceDirectory, error: (error as Error).message };
    }
  }
  async apply(): Promise<CielUpdateStatus> {
    if (this.pending || this.hasActiveRuns()) throw new Error('Finish active or queued sessions before updating CIEL.');
    this.pending = true;
    try {
      if (!await this.supported()) throw new Error('This installation cannot update itself. Use its installer instead.');
      const release = await newestLinuxRelease(this.directory(), CIEL_VERSION);
      if (!release) throw new Error('No newer CIEL release was found.');
      if (this.hasActiveRuns()) throw new Error('Finish active or queued sessions before updating CIEL.');
      await execute('systemd-run', ['--user', '--collect', `--unit=ciel-update-${Date.now()}`, '/bin/bash', this.helper, this.installDirectory, release.archive, release.version, String(this.port)], { timeout: 10000 });
      return { currentVersion: CIEL_VERSION, latestVersion: release.version, available: true, supported: true, busy: true, sourceDirectory: this.directory() };
    } catch (error) {
      this.pending = false;
      throw error;
    }
  }
  isPending(): boolean { return this.pending; }
}
