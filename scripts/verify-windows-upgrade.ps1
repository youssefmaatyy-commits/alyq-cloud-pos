[CmdletBinding()]
param(
  [string]$StableInstaller = 'release/ALYQ-POS-Setup-6.1.0-x64.exe'
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
  Invoke-InstalledSmoke -NodeArguments @('scripts/verify-windows-installed-app.mjs','--port=9222','--version=6.0.0','--allow-missing-desktop-api') -Label 'Installed 6.0.0 packaged-login/userData check'
  if (-not $oldProcess.HasExited) {
    $null = & taskkill.exe /PID $oldProcess.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $oldProcess.HasExited) { throw 'Could not close the isolated 6.0.0 app before upgrading.' }
  }

  $stage = 'capture and mark the isolated 6.0.0 userData configuration'
  Write-Host "UPGRADE_STAGE: $stage"
  $config = Get-ChildItem $env:APPDATA -Filter 'desktop-config.v1.json' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $config) {
    # The archived 6.0.0 renderer has no exposed preload bridge and does not
    # initialize a config until a hardware IPC is invoked. Seed the real schema
    # in its fresh Electron userData directory to exercise installer preservation.
    $userDataDirectory = Get-ChildItem $env:APPDATA -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '(?i)alyq' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($userDataDirectory) {
      $userData = $userDataDirectory.FullName
    } else {
      $userData = Join-Path $env:APPDATA 'ALYQ POS'
      New-Item -ItemType Directory -Path $userData -Force | Out-Null
    }
    $configPath = Join-Path $userData 'desktop-config.v1.json'
    $baselineInstallationId = [guid]::NewGuid().ToString()
    $seedConfig = [ordered]@{
      schemaVersion = 1
      installationId = $baselineInstallationId
      hardware = [ordered]@{
        printerName = $null
        paperWidthMm = 58
        copies = 1
        silentPrint = $true
        autoPrintAfterSale = $false
        drawerMode = 'none'
        autoOpenCashDrawer = $false
      }
      registerBinding = $null
    }
    $seedConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8NoBOM
    $config = Get-Item $configPath
    Write-Host "The clean 6.0.0 app did not create its optional hardware config before login; seeded valid schema in its isolated userData path: $userData"
  }
  $userData = $config.DirectoryName
  $configJson = Get-Content $config.FullName -Raw | ConvertFrom-Json
  if (-not $configJson.installationId) { throw 'The 6.0.0 configuration has no installation identity.' }
  $baselineInstallationId = $configJson.installationId
  if (-not $configJson.hardware) { throw 'The 6.0.0 userData configuration has no hardware settings object.' }
  # This is a clean, disposable runner profile. Seed a complete synthetic
  # printer/drawer configuration so every field — not only paper width — must
  # survive unchanged. No physical printer or Production register is contacted.
  $configJson.hardware = [ordered]@{
    printerName = 'ALYQ-Upgrade-Test-Printer'
    paperWidthMm = 58
    copies = 2
    silentPrint = $false
    autoPrintAfterSale = $true
    drawerMode = 'printer-driver'
    autoOpenCashDrawer = $true
  }
  $configJson | ConvertTo-Json -Depth 20 | Set-Content -Path $config.FullName -Encoding utf8NoBOM
  $storageSentinel = [guid]::NewGuid().ToString()
  $oldProcess = Start-Process -FilePath $oldExe.FullName -ArgumentList @('--disable-gpu','--remote-debugging-port=9224','--remote-debugging-address=127.0.0.1','--remote-allow-origins=*') -PassThru -WindowStyle Hidden
  Invoke-InstalledSmoke -NodeArguments @('scripts/verify-windows-installed-app.mjs','--port=9224','--version=6.0.0','--allow-missing-desktop-api',"--seed-storage-sentinel=$storageSentinel") -Label 'Restarted 6.0.0 login after seeding isolated userData'
  if (-not $oldProcess.HasExited) {
    $null = & taskkill.exe /PID $oldProcess.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $oldProcess.HasExited) { throw 'Could not close the restarted isolated 6.0.0 app before upgrading.' }
  }
  $configJson = Get-Content $config.FullName -Raw | ConvertFrom-Json
  if ($configJson.installationId -ne $baselineInstallationId) { throw 'The 6.0.0 restart changed its installation identity.' }
  if ($configJson.hardware.paperWidthMm -ne 58) { throw 'The isolated 58 mm setting did not persist when the 6.0.0 app restarted.' }
  $expectedConfig = Join-Path $env:RUNNER_TEMP 'alyq-windows-6.0.0-expected-config.json'
  Copy-Item -LiteralPath $config.FullName -Destination $expectedConfig -Force
  $originalConfigHash = (Get-FileHash $config.FullName -Algorithm SHA256).Hash
  $marker = Join-Path $userData 'arena-upgrade-preservation-check.txt'
  $markerValue = [guid]::NewGuid().ToString()
  Set-Content -Path $marker -Value $markerValue -NoNewline -Encoding ascii

  $stage = 'install the 6.1.0 candidate over the isolated 6.0.0 installation'
  Write-Host "UPGRADE_STAGE: $stage"
  $candidate = Start-Process -FilePath $StableInstaller -ArgumentList '/S' -PassThru -Wait
  if ($candidate.ExitCode -ne 0) { throw "Stable installer returned exit code $($candidate.ExitCode)." }
  $newExe = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'ALYQ POS.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $newExe) { throw 'Could not locate the installed 6.1.0 executable after upgrade.' }

  $stage = 'smoke-test the upgraded app and verify user settings/data preservation'
  Write-Host "UPGRADE_STAGE: $stage"
  $newProcess = Start-Process -FilePath $newExe.FullName -ArgumentList @('--disable-gpu','--remote-debugging-port=9223','--remote-debugging-address=127.0.0.1','--remote-allow-origins=*') -PassThru -WindowStyle Hidden
  Invoke-InstalledSmoke -NodeArguments @('scripts/verify-windows-installed-app.mjs','--port=9223','--version=6.1.0','--expect-paper-width=58',"--expect-config=$expectedConfig","--expect-storage-sentinel=$storageSentinel") -Label 'Installed 6.1.0 packaged-login/userData check'
  if (-not $newProcess.HasExited) {
    $null = & taskkill.exe /PID $newProcess.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $newProcess.HasExited) { throw 'Could not close the isolated candidate app after verification.' }
  }
  if (-not (Test-Path $marker) -or (Get-Content $marker -Raw) -ne $markerValue) { throw 'The 6.0.0 userData sentinel was not preserved by the candidate upgrade.' }
  if (-not (Test-Path $config.FullName)) { throw 'The 6.0.0 desktop configuration was removed by the candidate upgrade.' }
  if ((Get-FileHash $config.FullName -Algorithm SHA256).Hash -ne $originalConfigHash) { throw 'The desktop configuration changed during installer upgrade.' }
  Write-Host 'SAFE UPGRADE PASS: checksummed 6.0.0 install -> login/config/storage smoke -> complete synthetic hardware config + localStorage/IndexedDB/userData sentinels -> 6.1.0 upgrade -> login/config/storage smoke; installation identity, all hardware fields, config hash, and browser/userData sentinels survived unchanged.'
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "### Windows installed-app upgrade: **PASS**`nChecksummed 6.0.0 installer upgraded in an isolated GitHub-hosted Windows runner. The packaged login, installation identity, complete synthetic printer/drawer configuration, unchanged config hash, localStorage sentinel, IndexedDB sentinel, and userData sentinel were verified. Barcode and offline-sync contracts were checked separately by their focused test suites. No customer profile, physical printer, Production write, or Production order was used."
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
