param(
  [string]$RepoPath = "",
  [string]$Branch = "deploy-dashboard-latest-oi",
  [string]$PublishRef = "main",
  [string]$CommitMessage = "Update OI alert outcomes"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Log {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Output "[$stamp] $Message"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepoPath)) {
  $RepoPath = Resolve-Path (Join-Path $scriptDir "..")
} else {
  $RepoPath = Resolve-Path $RepoPath
}

$logDir = Join-Path $env:LOCALAPPDATA "TradingTerminal\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir "oi-alert-github-update.log"

$lockPath = Join-Path $env:TEMP "trading-terminal-oi-alert-github-update.lock"
$lockItem = $null

try {
  if (Test-Path $lockPath) {
    $lockAgeMinutes = ((Get-Date) - (Get-Item $lockPath).LastWriteTime).TotalMinutes
    if ($lockAgeMinutes -lt 30) {
      Write-Log "Another update appears to be running; exiting." | Tee-Object -FilePath $logPath -Append
      exit 0
    }
    Remove-Item -LiteralPath $lockPath -Force
  }
  $lockItem = New-Item -ItemType File -Path $lockPath -Value ([string]$PID) -Force

  Set-Location $RepoPath
  Write-Log "Starting OI alert outcome update in $RepoPath" | Tee-Object -FilePath $logPath -Append

  $currentBranch = (& git branch --show-current).Trim()
  if ($currentBranch -ne $Branch) {
    throw "Expected branch '$Branch' but current branch is '$currentBranch'. Aborting to avoid committing from the wrong branch."
  }

  $trackedDirty = & git status --porcelain --untracked-files=no
  if ($trackedDirty) {
    throw "Tracked working tree changes are present. Aborting so the scheduled updater does not mix with manual edits."
  }

  & git fetch origin $Branch $PublishRef | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }

  & git merge --ff-only "origin/$Branch" | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "git merge --ff-only failed" }

  & git merge --no-edit "origin/$PublishRef" | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "git merge origin/$PublishRef failed" }

  & node "scripts\export-oi-alert-outcomes.js" | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "OI alert outcome export failed" }

  & git add "data\oi-alert-outcomes.json"
  if ($LASTEXITCODE -ne 0) { throw "git add failed" }

  & git diff --cached --quiet -- "data\oi-alert-outcomes.json"
  if ($LASTEXITCODE -eq 0) {
    Write-Log "No OI alert outcome changes to publish." | Tee-Object -FilePath $logPath -Append
    exit 0
  }

  $stagedFiles = @(& git diff --cached --name-only)
  if ($stagedFiles.Count -ne 1 -or $stagedFiles[0] -ne "data/oi-alert-outcomes.json") {
    throw "Unexpected staged files: $($stagedFiles -join ', ')"
  }

  & git commit -m $CommitMessage | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

  & git push origin $Branch | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "git push $Branch failed" }

  & git push origin "${Branch}:${PublishRef}" | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "git push $PublishRef failed" }

  Write-Log "Published updated OI alert outcomes to GitHub." | Tee-Object -FilePath $logPath -Append
} catch {
  Write-Log "FAILED: $($_.Exception.Message)" | Tee-Object -FilePath $logPath -Append
  exit 1
} finally {
  if ($lockItem -ne $null -and (Test-Path $lockPath)) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
}
