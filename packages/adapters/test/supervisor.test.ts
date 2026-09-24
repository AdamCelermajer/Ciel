import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native supervisor stops its child when the host pipe closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ciel-supervisor-'));
  const pidFile = join(dir, 'native.pid');
  const env = { ...process.env };
  env.CIEL_SUPERVISOR_SPEC = JSON.stringify({ file: process.execPath,
    args: ['-e', `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`],
    stdin: 'ignore' });
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL('../src/engine-supervisor.cjs', import.meta.url))], {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let pids: number[] = [];
  for (let i = 0; i < 50; i++) {
    try { pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[]; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  expect(pids).toHaveLength(2);
  supervisor.stdin.end();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('supervisor did not exit')), 5000);
    supervisor.once('close', () => { clearTimeout(timer); resolve(); });
  });
  for (const pid of pids) {
    let alive = true;
    for (let i = 0; i < 20; i++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
      catch { alive = false; break; }
    }
    expect(alive).toBe(false);
  }
});
