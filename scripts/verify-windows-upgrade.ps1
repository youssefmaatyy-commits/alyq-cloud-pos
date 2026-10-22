[CmdletBinding()]
param(
  [string]$PreviewInstaller = 'release/ALYQ-POS-Setup-6.1.0-preview.1-x64.exe'
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:RUNNER_TEMP 'alyq-windows-upgrade.log'
$oldProcess = $null
$newProcess = $null
$stage = 'initialize'
Start-Transcript -Path $logPath -Append | Out-Null

function Invoke-InstalledSmoke([string[]]$NodeArguments, [string]$Label) {
  $output = @(& node @NodeArguments 2>&1 | ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) { Write-Host "SMOKE: $line" }
  if ($exitCode -ne 0) {
    $detail = ($output -join ' | ') -replace '[\r\n]+', ' '
    if ($detail.Length -gt 1400) { $detail = $detail.Substring($detail.Length - 1400) }
    throw "$Label returned Node exit code $exitCode. $detail"
  }
}

try {
  $baseline = Join-Path $env:RUNNER_TEMP 'ALYQ-POS-Setup-6.0.0-x64.exe'
  $checksumFile = "$baseline.sha256"
  $releaseBase = 'https://github.com/youssefmaatyy-commits/alyq-cloud-pos/releases/download/v2.1.0-rc1'

  $stage = 'download and checksum the existing 6.0.0 installer'
  Write-Host "UPGRADE_STAGE: $stage"
  Invoke-WebRequest "$releaseBase/ALYQ-POS-Setup-6.0.0-x64.exe" -OutFile $baseline
  Invoke-WebRequest "$releaseBase/ALYQ-POS-Setup-6.0.0-x64.exe.sha256" -OutFile $checksumFile
  $checksumText = Get-Content $checksumFile -Raw
  if ($checksumText -notmatch '(?i)^\s*([0-9a-f]{64})') { throw 'The published 6.0.0 checksum file is malformed.' }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $actualHash = (Get-FileHash $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw 'The published 6.0.0 installer checksum did not match.' }
  Write-Host "Verified SHA-256 for the existing 6.0.0 installer."

  $stage = 'install and smoke-test the isolated 6.0.0 app'
  Write-Host "UPGRADE_STAGE: $stage"
  $baselineInstall = Start-Process -FilePath $baseline -ArgumentList '/S' -PassThru -Wait
  if ($baselineInstall.ExitCode -ne 0) { throw "6.0.0 silent installation returned exit code $($baselineInstall.ExitCode)." }
  $oldExe = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'ALYQ POS.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $oldExe) { throw 'Could not locate the installed 6.0.0 ALYQ POS executable.' }
  $oldProcess = Start-Process -FilePath $oldExe.FullName -ArgumentList @('--disable-gpu','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--remote-allow-origins=*') -PassThru -WindowStyle Hidden
  Invoke-InstalledSmoke -NodeArguments @('scripts/verify-windows-installed-app.mjs','--port=9222','--version=6.0.0','--seed-paper-width=58') -Label 'Installed 6.0.0 packaged-login/userData check'
  if (-not $oldProcess.HasExited) {
    $null = & taskkill.exe /PID $oldProcess.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $oldProcess.HasExited) { throw 'Could not close the isolated 6.0.0 app before upgrading.' }
  }

  $stage = 'capture and mark the isolated 6.0.0 userData configuration'
  Write-Host "UPGRADE_STAGE: $stage"
  $config = Get-ChildItem $env:APPDATA -Filter 'desktop-config.v1.json' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $config) { throw 'Could not locate the 6.0.0 desktop configuration under AppData.' }
  $userData = $config.DirectoryName
  $configJson = Get-Content $config.FullName -Raw | ConvertFrom-Json
  if (-not $configJson.installationId) { throw 'The 6.0.0 configuration has no installation identity.' }
  if ($configJson.hardware.paperWidthMm -ne 58) { throw 'The isolated custom 58 mm paper-width setting did not persist before the upgrade.' }
  $originalConfigHash = (Get-FileHash $config.FullName -Algorithm SHA256).Hash
  $marker = Join-Path $userData 'arena-upgrade-preservation-check.txt'
  $markerValue = [guid]::NewGuid().ToString()
  Set-Content -Path $marker -Value $markerValue -NoNewline -Encoding ascii

  $stage = 'install the 6.1.0 preview over the isolated 6.0.0 installation'
  Write-Host "UPGRADE_STAGE: $stage"
  $preview = Start-Process -FilePath $PreviewInstaller -ArgumentList '/S' -PassThru -Wait
  if ($preview.ExitCode -ne 0) { throw "Preview installer returned exit code $($preview.ExitCode)." }
  $newExe = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'ALYQ POS.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $newExe) { throw 'Could not locate the installed 6.1.0-preview.1 executable after upgrade.' }

  $stage = 'smoke-test the upgraded app and verify user settings/data preservation'
  Write-Host "UPGRADE_STAGE: $stage"
  $newProcess = Start-Process -FilePath $newExe.FullName -ArgumentList @('--disable-gpu','--remote-debugging-port=9223','--remote-debugging-address=127.0.0.1','--remote-allow-origins=*') -PassThru -WindowStyle Hidden
  Invoke-InstalledSmoke -NodeArguments @('scripts/verify-windows-installed-app.mjs','--port=9223','--version=6.1.0-preview.1','--expect-paper-width=58') -Label 'Installed 6.1.0-preview.1 packaged-login/userData check'
  if (-not $newProcess.HasExited) {
    $null = & taskkill.exe /PID $newProcess.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $newProcess.HasExited) { throw 'Could not close the isolated preview app after verification.' }
  }
  if (-not (Test-Path $marker) -or (Get-Content $marker -Raw) -ne $markerValue) { throw 'The 6.0.0 userData sentinel was not preserved by the preview upgrade.' }
  if (-not (Test-Path $config.FullName)) { throw 'The 6.0.0 desktop configuration was removed by the preview upgrade.' }
  if ((Get-FileHash $config.FullName -Algorithm SHA256).Hash -ne $originalConfigHash) { throw 'The desktop configuration changed during installer upgrade.' }
  Write-Host 'SAFE UPGRADE PASS: checksummed 6.0.0 install -> login/config smoke -> non-default 58 mm setting + userData sentinel -> 6.1.0-preview.1 upgrade -> login/config smoke; setting and config hash plus sentinel survived unchanged.'
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "### Windows installed-app upgrade: **PASS**`nChecksummed 6.0.0 installer upgraded in an isolated runner profile. The packaged login, installation identity, custom 58 mm receipt setting, unchanged config hash, and userData sentinel were verified. No customer profile, Production data, or Production order was used."
} catch {
  $detail = ($_.Exception.Message -replace '[\r\n]+', ' ').Trim()
  Write-Host "::error title=Windows upgrade verification failed::$stage — $detail"
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "### Windows installed-app upgrade: **FAIL**`nStage: $stage`nReason: $detail"
  throw
} finally {
  foreach ($process in @($oldProcess, $newProcess)) {
    if ($null -ne $process -and -not $process.HasExited) {
      $null = & taskkill.exe /PID $process.Id /T /F 2>&1
    }
  }
  Stop-Transcript | Out-Null
}
