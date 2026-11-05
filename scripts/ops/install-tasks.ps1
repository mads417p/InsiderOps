<#
.SYNOPSIS
  Installerer InsiderOps' to planlagte opgaver i Task Scheduler-mappen \InsiderOps\ (fase 9):
    Scan      man-fre 14:45   npm run scan       (før det amerikanske marked åbner 15:30)
    Outcomes  man-fre 22:30   npm run outcomes   (efter lukning 22:00)
  Opgaverne kører som dig og kun, når du er logget ind (ingen gemt adgangskode). Dev-serveren skal ikke køre.
  StartWhenAvailable: var pc'en slukket eller i dvale, køres opgaven, når den er tilgængelig igen. Pc'en vækkes ikke.
  Kør igen for at opdatere (-Force overskriver). Fjern med uninstall-tasks.ps1.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\install-tasks.ps1
#>
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-job.ps1'
$days = 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$jobs = @(
  @{ Name = 'Scan'; Job = 'scan'; At = '14:45' },
  @{ Name = 'Outcomes'; Job = 'outcomes'; At = '22:30' }
)
foreach ($j in $jobs) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Job $($j.Job)"
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $j.At
  Register-ScheduledTask -TaskPath '\InsiderOps\' -TaskName $j.Name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description "InsiderOps: npm run $($j.Job) (log i data\logs)" -Force | Out-Null
  Write-Host "Installeret: \InsiderOps\$($j.Name) - man-fre kl. $($j.At)"
}
Get-ScheduledTask -TaskPath '\InsiderOps\' | Select-Object TaskName, State | Format-Table -AutoSize
