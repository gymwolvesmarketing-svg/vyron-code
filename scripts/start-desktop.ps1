<#
.SYNOPSIS
  Launches Vyron Code Desktop by invoking the compiled Electron main process directly.

.DESCRIPTION
  VYRON_CODE_V02_A00_EXTERNAL_PROCESS_TERMINATION_TRACE_AUTHORIZATION / user-owned runtime
  acceptance cleanup. `npx electron ...` does not run electron.exe directly — it runs through
  an intermediate node.exe wrapper (node_modules/electron/cli.js) that spawns electron.exe as
  a non-detached child process. On this machine, that wrapper was confirmed, via a live,
  user-owned test, to cause Electron to self-close at a variable, unpredictable time (observed
  between under 90 seconds and over 210 seconds) with no Electron-level or Node-level
  graceful-shutdown event of any kind. The exact same compiled artifact, launched directly (no
  node.exe wrapper in between), stayed open a full 10-minute idle test and closed only on an
  explicit, normal user action. See VYRON_CODE_V02_A00_EXTERNAL_PROCESS_TERMINATION_TRACE_REPORT.md
  for the full trace.

  This script performs the same direct invocation, run by PowerShell itself with no
  intermediate Node/npm/npx process — deliberately NOT wrapped as an "npm run" script, since
  npm's own script execution also spawns through Node and could reintroduce the same class of
  issue this script exists to avoid.

  This script performs no build step. Run `npm run build:electron` first if
  dist-electron/electron/main.js does not exist yet or is stale.

.EXAMPLE
  .\scripts\start-desktop.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$electronBinary = Join-Path $repoRoot "node_modules\electron\dist\electron.exe"
$mainScript = Join-Path $repoRoot "dist-electron\electron\main.js"

if (-not (Test-Path $electronBinary)) {
    Write-Error "Electron binary not found at node_modules\electron\dist\electron.exe — run 'npm install' first."
    exit 1
}
if (-not (Test-Path $mainScript)) {
    Write-Error "Compiled Electron entry point not found at dist-electron\electron\main.js — run 'npm run build:electron' first."
    exit 1
}

& $electronBinary $mainScript
exit $LASTEXITCODE
