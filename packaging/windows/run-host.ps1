$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object System.Threading.Mutex($false, ('Global\CIELHost-' + $sid))
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  $logs = Join-Path $env:LOCALAPPDATA 'CIEL\logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $env:PATH = (Join-Path $root 'runtime') + ';' + $env:PATH
  while ($true) {
    $proc = Start-Process -FilePath (Join-Path $root 'runtime\node.exe') -ArgumentList ('"' + (Join-Path $root 'dist\host\main.cjs') + '"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $logs 'host.out.log') -RedirectStandardError (Join-Path $logs 'host.err.log')
    if ($proc.ExitCode -eq 0) { break }
    Start-Sleep -Seconds 5
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
