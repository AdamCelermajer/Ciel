// Native process-tree guardian. The host owns this process's stdin pipe; EOF
// means the host exited (including abrupt termination), so stop the native tree.
const { spawn } = require('node:child_process');
const { join } = require('node:path');

let spec;
try { spec = JSON.parse(process.env.CIEL_SUPERVISOR_SPEC); }
catch { process.stderr.write('CIEL native supervisor received invalid launch data\n'); process.exit(1); }
const env = { ...process.env };
delete env.CIEL_SUPERVISOR_SPEC;
const native = spawn(spec.file, spec.args, {
  cwd: spec.cwd, env, windowsHide: true,
  detached: process.platform !== 'win32',
  stdio: [spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
});
native.stdout.pipe(process.stdout);
native.stderr.pipe(process.stderr);
if (spec.stdin === 'pipe') process.stdin.pipe(native.stdin);
else process.stdin.resume();

let stopping = false;
function groupAlive() {
  if (!native.pid || process.platform === 'win32') return false;
  try { process.kill(-native.pid, 0); return true; }
  catch { return false; }
}
function stopTree() {
  if (stopping || !native.pid) return;
  stopping = true;
  if (process.platform === 'win32') {
    if (native.exitCode !== null) return;
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(native.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    killer.on('error', () => native.kill('SIGKILL'));
    return;
  }
  try { process.kill(-native.pid, 'SIGTERM'); } catch { /* Group already exited. */ }
  const fallback = setTimeout(() => { if (groupAlive()) { try { process.kill(-native.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 2000);
  fallback.unref();
}
process.stdin.once('end', stopTree);
process.stdin.once('error', stopTree);
process.on('SIGTERM', stopTree);
native.once('error', error => { process.stderr.write(`CIEL native launch failed: ${error.message}\n`); process.exitCode = 1; });
native.once('close', async code => {
  if (process.platform !== 'win32' && groupAlive()) {
    stopTree();
    for (let i = 0; i < 80 && groupAlive(); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (groupAlive()) { try { process.kill(-native.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
  }
  process.exit(code ?? 1);
});
