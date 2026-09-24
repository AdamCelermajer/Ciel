import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function listFolders(input?: string) {
  const folder = await realpath(input || homedir());
  if (!(await stat(folder)).isDirectory()) throw new Error('Folder is not a directory');
  const entries = await readdir(folder, { withFileTypes: true });
  const directories = (await Promise.all(entries.map(async entry => {
    if (entry.isDirectory()) return entry.name;
    if (!entry.isSymbolicLink()) return undefined;
    try { return (await stat(path.join(folder, entry.name))).isDirectory() ? entry.name : undefined; }
    catch { return undefined; }
  }))).filter((name): name is string => !!name).sort((a, b) => a.localeCompare(b));
  return { path: folder, parent: path.dirname(folder) === folder ? null : path.dirname(folder), directories };
}

export async function pickFolder(): Promise<string | null> {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Choose a project folder"; if ($dialog.ShowDialog() -eq "OK") { [Console]::WriteLine($dialog.SelectedPath) }'];
  } else if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "Choose a project folder")'];
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('No desktop folder picker is available');
    command = 'zenity';
    args = ['--file-selection', '--directory', '--title=Choose a project folder'];
  }
  try {
    const { stdout } = await run(command, args, { timeout: 120000, maxBuffer: 8192, windowsHide: false });
    const chosen = stdout.trim();
    return chosen ? (await listFolders(chosen)).path : null;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === '1') return null;
    throw new Error('System folder picker is unavailable');
  }
}
