<#
.SYNOPSIS
  Fjerner InsiderOps' planlagte opgaver (\InsiderOps\Scan og \InsiderOps\Outcomes). Logfilerne i data\logs bliver.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\uninstall-tasks.ps1
#>
foreach ($name in 'Scan', 'Outcomes') {
  try {
    Unregister-ScheduledTask -TaskPath '\InsiderOps\' -TaskName $name -Confirm:$false -ErrorAction Stop
    Write-Host "Fjernet: \InsiderOps\$name"
  } catch {
    Write-Host "Fandtes ikke: \InsiderOps\$name"
  }
}
