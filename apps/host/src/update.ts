import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { CielUpdateStatus } from '@ciel/contracts';
import { CIEL_VERSION } from '@ciel/contracts';

const execute = promisify(execFile);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const maxArchiveBytes = 1024 * 1024 * 1024;
export interface PublishedRelease { version: string; url: string; archiveUrl: string; size: number; sha256: string }
type Fetcher = typeof fetch;

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export async function latestPublishedRelease(repository: string, currentVersion: string, fetcher: Fetcher = fetch, platform: 'linux' | 'windows' = 'linux'): Promise<PublishedRelease | undefined> {
  if (!repositoryPattern.test(repository)) throw new Error('CIEL release repository is not configured.');
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `CIEL/${currentVersion}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
  const release = await response.json() as {
    tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean;
    assets?: Array<{ name?: string; state?: string; size?: number; digest?: string; browser_download_url?: string }>;
  };
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');
  if (!match || release.draft || release.prerelease || compareVersions(match[1]!, currentVersion) <= 0) return undefined;
  const version = match[1]!;
  const assetName = platform === 'windows' ? `ciel-${version}-setup.exe` : `ciel-${version}-linux-x64.tar.gz`;
  const asset = release.assets?.find(item => item.name === assetName && item.state === 'uploaded');
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? '');
  if (!asset || !digest || !asset.size || asset.size > maxArchiveBytes || !asset.browser_download_url) return undefined;
  const archiveUrl = new URL(asset.browser_download_url);
  const expectedPath = `/${repository}/releases/download/${release.tag_name}/${assetName}`;
  if (archiveUrl.protocol !== 'https:' || archiveUrl.hostname !== 'github.com' || archiveUrl.pathname !== expectedPath) return undefined;
  const page = new URL(release.html_url ?? '', `https://github.com/${repository}/releases`);
  if (page.protocol !== 'https:' || page.hostname !== 'github.com' || !page.pathname.startsWith(`/${repository}/releases/`)) return undefined;
  return { version, url: page.href, archiveUrl: archiveUrl.href, size: asset.size, sha256: digest[1]!.toLowerCase() };
}

export async function downloadRelease(release: PublishedRelease, directory: string, fetcher: Fetcher = fetch): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.download-${randomUUID()}.part`);
  const archive = path.join(directory, `ciel-${release.version}-linux-x64.tar.gz`);
  try {
    const response = await fetcher(release.archiveUrl, { headers: { 'user-agent': `CIEL/${CIEL_VERSION}` }, signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`GitHub release download failed (${response.status}).`);
    if (new URL(response.url).protocol !== 'https:') throw new Error('Release download was redirected to an insecure URL.');
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > release.size || size > maxArchiveBytes) return callback(new Error('Release archive exceeded its published size.'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(response.body, verify, createWriteStream(temporary, { mode: 0o600 }));
    if (size !== release.size || hash.digest('hex') !== release.sha256) throw new Error('Release archive checksum does not match GitHub.');
    await rename(temporary, archive);
    return archive;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class CielUpdater {
  private pending = false;
  private checkedAt = 0;
  private cached?: PublishedRelease;
  private checking?: Promise<PublishedRelease | undefined>;
  private readonly installDirectory: string;
  private readonly helper: string;
  constructor(private dataDirectory: string, private port: number, private repository: string, private hasActiveRuns: () => boolean, private fetcher: Fetcher = fetch) {
    this.installDirectory = path.join(dataDirectory, 'app');
    this.helper = path.join(dataDirectory, 'ciel-update');
  }
  private async supported(): Promise<boolean> {
    if (process.platform !== 'linux' || !existsSync(this.helper)) return false;
    try { return await realpath(process.cwd()) === await realpath(this.installDirectory); }
    catch { return false; }
  }
  private async release(force = false): Promise<PublishedRelease | undefined> {
    if (!force && Date.now() - this.checkedAt < 60000) return this.cached;
    if (this.checking) return this.checking;
    this.checking = latestPublishedRelease(this.repository, CIEL_VERSION, this.fetcher, process.platform === 'win32' ? 'windows' : 'linux');
    try { this.cached = await this.checking; this.checkedAt = Date.now(); return this.cached; }
    finally { this.checking = undefined; }
  }
  async status(force = false): Promise<CielUpdateStatus> {
    const supported = await this.supported();
    const busy = this.pending || this.hasActiveRuns();
    try {
      const release = await this.release(force);
      return { currentVersion: CIEL_VERSION, latestVersion: release?.version, releaseUrl: release?.url, available: !!release, supported, busy };
    } catch (error) {
      return { currentVersion: CIEL_VERSION, available: false, supported, busy, error: (error as Error).message };
    }
  }
  async apply(): Promise<CielUpdateStatus> {
    if (this.pending || this.hasActiveRuns()) throw new Error('Finish active or queued sessions before updating CIEL.');
    this.pending = true;
    try {
      if (!await this.supported()) throw new Error('This installation cannot update itself. Use its installer instead.');
      const release = await this.release(true);
      if (!release) throw new Error('No newer published CIEL release was found.');
      const archive = await downloadRelease(release, path.join(this.dataDirectory, 'updates'), this.fetcher);
      if (this.hasActiveRuns()) throw new Error('Finish active or queued sessions before updating CIEL.');
      await execute('systemd-run', ['--user', '--collect', `--unit=ciel-update-${Date.now()}`, '/bin/bash', this.helper, this.installDirectory, archive, release.version, String(this.port)], { timeout: 10000 });
      return { currentVersion: CIEL_VERSION, latestVersion: release.version, releaseUrl: release.url, available: true, supported: true, busy: true };
    } catch (error) {
      this.pending = false;
      throw error;
    }
  }
  isPending(): boolean { return this.pending; }
}
