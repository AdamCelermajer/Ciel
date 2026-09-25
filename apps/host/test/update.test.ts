import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CielUpdater, compareVersions, downloadRelease, latestPublishedRelease } from '../src/update.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const repository='example/ciel';
const archive=Buffer.from('verified release archive');
const sha256=createHash('sha256').update(archive).digest('hex');
const assetUrl='https://github.com/example/ciel/releases/download/v0.2.0/ciel-0.2.0-linux-x64.tar.gz';
const release={
  tag_name:'v0.2.0',html_url:'https://github.com/example/ciel/releases/tag/v0.2.0',draft:false,prerelease:false,
  assets:[{name:'ciel-0.2.0-linux-x64.tar.gz',state:'uploaded',size:archive.length,digest:`sha256:${sha256}`,browser_download_url:assetUrl}],
};
const fakeFetch=(body:unknown,status=200):typeof fetch => async () => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const assetFetch=(bytes:Buffer):typeof fetch => async () => {
  const response=new Response(new Uint8Array(bytes),{status:200});
  Object.defineProperty(response,'url',{value:assetUrl});
  return response;
};

describe('published GitHub release updates', () => {
  it('shows only a newer published full release with a complete verified asset', async () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect((await latestPublishedRelease(repository,'0.1.4',fakeFetch(release)))?.version).toBe('0.2.0');
    expect(await latestPublishedRelease(repository,'0.2.0',fakeFetch(release))).toBeUndefined();
    expect(await latestPublishedRelease(repository,'0.1.4',fakeFetch({...release,draft:true}))).toBeUndefined();
    expect(await latestPublishedRelease(repository,'0.1.4',fakeFetch({...release,prerelease:true}))).toBeUndefined();
    expect(await latestPublishedRelease(repository,'0.1.4',fakeFetch({...release,assets:[]}))).toBeUndefined();
    expect(await latestPublishedRelease(repository,'0.1.4',fakeFetch({},404))).toBeUndefined();
  });
  it('checks archive bytes before saving an update', async () => {
    const directory=await mkdtemp(path.join(os.tmpdir(),'ciel-updates-'));directories.push(directory);
    const published=(await latestPublishedRelease(repository,'0.1.4',fakeFetch(release)))!;
    const saved=await downloadRelease(published,directory,assetFetch(archive));
    expect(await readFile(saved)).toEqual(archive);
    await expect(downloadRelease({...published,sha256:'0'.repeat(64)},directory,assetFetch(archive))).rejects.toThrow('checksum');
    expect(await readdir(directory)).toEqual([path.basename(saved)]);
  });
  it('ignores a local archive and refuses to self-update a development checkout', async () => {
    const directory=await mkdtemp(path.join(os.tmpdir(),'ciel-updates-'));directories.push(directory);
    await writeFile(path.join(directory,'ciel-9.9.9-linux-x64.tar.gz'),'local build');
    const updater=new CielUpdater(directory,4317,repository,()=>false,fakeFetch(release));
    const status=await updater.status();
    expect(status.available).toBe(true);
    expect(status.supported).toBe(false);
    await expect(updater.apply()).rejects.toThrow('cannot update itself');
    const noRelease=new CielUpdater(directory,4317,repository,()=>false,fakeFetch({},404));
    expect((await noRelease.status()).available).toBe(false);
  });
  it('rechecks GitHub when Check now is requested', async () => {
    const directory=await mkdtemp(path.join(os.tmpdir(),'ciel-updates-'));directories.push(directory);
    let checks=0;
    const fetcher:typeof fetch=async () => { checks++; return new Response(JSON.stringify(release)); };
    const updater=new CielUpdater(directory,4317,repository,()=>false,fetcher);
    await updater.status();
    await updater.status();
    expect(checks).toBe(1);
    await updater.status(true);
    expect(checks).toBe(2);
  });
});
