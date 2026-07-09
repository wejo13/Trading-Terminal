param(
  [int]$EveryMinutes = 15,
  [string]$TaskName = "TradingTerminal-OIAlertGithubUpdate"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($EveryMinutes -lt 5) {
  throw "EveryMinutes must be at least 5 to avoid noisy GitHub/Binance polling."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoPath = Resolve-Path (Join-Path $scriptDir "..")
$updateScript = Join-Path $scriptDir "update-oi-alert-outcomes.ps1"

if ((Test-Path $updateScript) -eq $false) {
  throw "Missing update script: $updateScript"
}

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$updateScript`" -RepoPath `"$repoPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Exports OI alert outcomes from the local radar state and pushes the website JSON snapshot to GitHub." `
  -Force | Out-Null

Write-Output "Registered scheduled task '$TaskName' to run every $EveryMinutes minutes."
Write-Output "Update script: $updateScript"
Write-Output "Repo path: $repoPath"
