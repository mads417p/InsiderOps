<#
.SYNOPSIS
  Kører ét InsiderOps-job og logger til data\logs\<job>-<yyyy-MM-dd>.log (fase 9).
  Kun til manuel kørsel – InsiderOps har ingen planlagte opgaver.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\run-job.ps1 -Job scan
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('scan', 'outcomes')]
  [string]$Job
)

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$logDir = Join-Path $repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('{0}-{1:yyyy-MM-dd}.log' -f $Job, (Get-Date))

Add-Content -Path $log -Encoding UTF8 -Value "=== $(Get-Date -Format s) start: npm run $Job ==="
# cmd /c, så npm's stdout og stderr havner rent i loggen (PowerShell 5.1 pakker stderr ind i fejlobjekter).
cmd /c "npm run $Job >> `"$log`" 2>&1"
$code = $LASTEXITCODE
Add-Content -Path $log -Encoding UTF8 -Value "=== $(Get-Date -Format s) slut: exitkode $code ==="
exit $code
