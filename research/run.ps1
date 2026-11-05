# Fase 4-backtest. Eksempler:
#   .\research\run.ps1 -Step setup     # venv + pakker (Python 3.13)
#   .\research\run.ps1 -Step test      # låste regler
#   .\research\run.ps1 -Step fetch     # SEC-bulk + Yahoo (cache; kan genoptages)
#   .\research\run.ps1 -Step build     # transaktioner, accepttid, population, enheder, features
#   .\research\run.ps1 -Step analyze   # in-sample (entry før 2025) → reports/backtest-v1.md
#   .\research\run.ps1 -Step holdout   # kun efter committet reports/holdout-plan.md
#   .\research\run.ps1 -Step se fetch|map|build    # fase 4-SE (reports/prereg-se.md)
#   .\research\run.ps1 -Step se_analyze [holdout]  # fase 4-SE-rapport; holdout kun efter committet holdout-plan-se.md
param(
  [ValidateSet('setup', 'test', 'fetch', 'build', 'analyze', 'holdout', 'se', 'se_analyze')][string]$Step = 'test',
  [Parameter(ValueFromRemainingArguments = $true)]$Rest
)
$ErrorActionPreference = 'Stop'
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
switch ($Step) {
  'setup' {
    py -3.13 -m venv (Join-Path $PSScriptRoot '.venv')
    & $py -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt')
  }
  'test' { & $py (Join-Path $PSScriptRoot 'tests\test_core.py') }
  default { & $py (Join-Path $PSScriptRoot "src\$Step.py") @Rest }
}
exit $LASTEXITCODE
