import { mkdir, readFile, writeFile, cp, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const root = process.cwd();
const version = JSON.parse(await readFile('package.json', 'utf8')).version as string;
const target = process.argv[2] ?? process.platform;
const releases = path.join(root, 'releases');
const cache = path.join(root, '.cache', 'packaging');
await mkdir(releases, { recursive: true }); await mkdir(cache, { recursive: true });
const indexResponse = await fetch('https://nodejs.org/dist/index.json');
if (!indexResponse.ok) throw new Error('Cannot obtain official Node release index');
const index = await indexResponse.json() as { version: string; lts: string | false }[];
const nodeVersion = process.env.CIEL_NODE_VERSION ?? index.find(item => item.version.startsWith('v24.') && item.lts)?.version;
if (!nodeVersion || !/^v24\.\d+\.\d+$/.test(nodeVersion)) throw new Error('A stable Node 24 LTS version is required');
const sumsResponse = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`);
if (!sumsResponse.ok) throw new Error('Cannot obtain Node release checksums');
const sums = await sumsResponse.text();
async function download(file: string) {
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
  if (!expected) throw new Error(`No official checksum for ${file}`);
  const output = path.join(cache, file);
  let bytes: Buffer;
  try { bytes = await readFile(output); }
  catch { const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${file}`); if (!response.ok) throw new Error(`Download failed: ${response.status}`); bytes = Buffer.from(await response.arrayBuffer()); }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Checksum mismatch: ${file}`);
  await writeFile(output, bytes); return output;
}
async function base(platform: string) {
  const stage = path.join(releases, `ciel-${version}-${platform}-x64`);
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
  await cp(path.join(root, 'packaging', platform), path.join(stage, 'setup'), { recursive: true });
  await cp(path.join(root, 'apps/web/public/ciel.svg'), path.join(stage, 'ciel.svg'));
  await writeFile(path.join(stage, 'version.txt'), version);
  await writeFile(path.join(stage, 'release.json'), JSON.stringify({ version, nodeVersion, platform, arch: 'x64', builtAt: new Date().toISOString() }, null, 2));
  await cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
  await cp(path.join(root, 'IMPLEMENTATION_PLAN.md'), path.join(stage, 'IMPLEMENTATION_PLAN.md'));
  await mkdir(path.join(stage, 'docs'));
  for (const file of ['VERIFICATION.md', 'ENGINE_VERIFICATION.md', 'OPERATIONS_AND_CAPABILITIES.md']) await cp(path.join(root, 'docs', file), path.join(stage, 'docs', file));
  return stage;
}
if (target === 'prefetch') {
  await Promise.all([download(`node-${nodeVersion}-linux-x64.tar.xz`), download(`node-${nodeVersion}-win-x64.zip`)]);
  process.stdout.write(`Official Node ${nodeVersion} archives verified.\n`);
}
if (['linux', 'all'].includes(target)) {
  const file = await download(`node-${nodeVersion}-linux-x64.tar.xz`);
  const stage = await base('linux'); await mkdir(path.join(stage, 'runtime'));
  await exec('tar', ['-xJf', file, '--strip-components=1', '-C', path.join(stage, 'runtime')]);
  for (const file of ['install.sh', 'ciel-open']) await chmod(path.join(stage, 'setup', file), 0o755);
  await exec('tar', ['-czf', `${stage}.tar.gz`, '-C', releases, path.basename(stage)]);
  if (process.platform === 'linux') {
    const rpmRoot = path.join(cache, 'rpm'); await mkdir(path.join(rpmRoot, 'SOURCES'), { recursive: true });
    await cp(`${stage}.tar.gz`, path.join(rpmRoot, 'SOURCES', `ciel-${version}.tar.gz`));
    const spec = (await readFile('packaging/linux/ciel.spec', 'utf8')).replaceAll('@VERSION@', version);
    const rpmRelease = /^Release:\s*(\d+)\s*$/m.exec(spec)?.[1];
    if (!rpmRelease) throw new Error('RPM spec must declare a numeric release');
    await writeFile(path.join(rpmRoot, 'ciel.spec'), spec);
    await exec('rpmbuild', ['-bb', '--define', `_topdir ${rpmRoot}`, path.join(rpmRoot, 'ciel.spec')], { maxBuffer: 5 * 1024 * 1024 });
    await cp(path.join(rpmRoot, 'RPMS/x86_64', `ciel-${version}-${rpmRelease}.x86_64.rpm`), path.join(releases, `ciel-${version}-${rpmRelease}.x86_64.rpm`));
  }
  process.stdout.write(`Linux bundle ready: ${stage}\n`);
}
if (['win32', 'windows', 'all'].includes(target)) {
  const file = await download(`node-${nodeVersion}-win-x64.zip`);
  const stage = await base('windows');
  const unpack = path.join(cache, 'windows'); await rm(unpack, { recursive: true, force: true }); await mkdir(unpack);
  await exec('unzip', ['-q', file, '-d', unpack]);
  await cp(path.join(unpack, `node-${nodeVersion}-win-x64`), path.join(stage, 'runtime'), { recursive: true });
  await rm(`${stage}.zip`, { force: true });
  await exec('zip', ['-qr', `${stage}.zip`, '.'], { cwd: stage });
  process.stdout.write(`Windows payload ready: ${stage}.zip (compile setup with setup/build-installer.ps1 on Windows)\n`);
}
