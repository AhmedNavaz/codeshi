# Installs the latest Codeshi release on Windows:
#   irm https://raw.githubusercontent.com/AhmedNavaz/throughline/main/install.ps1 | iex
# $env:CODESHI_VERSION = '0.16.0' installs a specific version. $env:CODESHI_INSTALL_DIR changes the folder that holds
# the Codeshi folder (default %LOCALAPPDATA%\Programs). Codeshi was called Throughline: the THROUGHLINE_ names work too,
# and the Throughline folder and Start menu shortcut there are replaced, keeping your workspaces and settings.
# Run as a script block so a failure ends the installer, not the PowerShell window it was pasted into.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell downloads far more slowly while it draws a progress bar.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'AhmedNavaz/throughline'
  function Fail([string]$message) { throw "codeshi: $message" }

  if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Codeshi needs 64-bit Windows.' }

  $version = if ($env:CODESHI_VERSION) { $env:CODESHI_VERSION } else { $env:THROUGHLINE_VERSION }
  if (-not $version) {
    try { $version = (Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest").tag_name }
    catch { Fail 'Could not reach GitHub.' }
  }
  $version = "$version" -replace '^v', ''
  if ($version -notmatch '^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$') { Fail 'Could not find the latest release.' }

  $folder = if ($env:CODESHI_INSTALL_DIR) { $env:CODESHI_INSTALL_DIR } else { $env:THROUGHLINE_INSTALL_DIR }
  $parent = if ($folder) { $folder } else { Join-Path $env:LOCALAPPDATA 'Programs' }
  $dest = Join-Path $parent 'Codeshi'
  $legacy = Join-Path $parent 'Throughline'
  if (Get-Process -Name 'Codeshi', 'Throughline' -ErrorAction SilentlyContinue) { Fail 'Quit Codeshi, then run the installer again.' }

  $base = "https://github.com/$repo/releases/download/v$version"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('codeshi-' + [guid]::NewGuid())
  $replaced = $false
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile (Join-Path $tmp 'SHA256SUMS.txt') } catch { Fail 'Could not download the checksums.' }
    $sums = @{}
    foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS.txt')) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $sums[$Matches[2]] = $Matches[1].ToLowerInvariant() }
    }
    # Releases from before the rename name their files after Throughline.
    $file = @("Codeshi-$version-windows-x64.zip", "Throughline-$version-windows-x64.zip") | Where-Object { $sums.ContainsKey($_) } | Select-Object -First 1
    if (-not $file) { Fail "Could not find Codeshi $version for Windows." }

    Write-Host "Downloading Codeshi $version for Windows..."
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $tmp $file) } catch { Fail "Could not download $file." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $file)).Hash.ToLowerInvariant()
    if ($sums[$file] -ne $actual) { Fail 'The download does not match its published checksum. Nothing was installed.' }

    Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath (Join-Path $tmp 'app')
    $app = $null; $exe = $null
    foreach ($name in 'Codeshi', 'Throughline') {
      $candidate = Join-Path $tmp "app\$name"
      if (Test-Path (Join-Path $candidate "$name.exe")) { $app = $candidate; $exe = "$name.exe"; break }
    }
    if (-not $app) { Fail 'The download does not contain Codeshi.exe.' }
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    # Copied rather than moved, so a folder on another drive works too.
    Copy-Item -Recurse -Path $app -Destination $dest

    # Codeshi adds its app ID to this shortcut when it starts, which Windows needs to show its notifications.
    $programs = [Environment]::GetFolderPath('Programs')
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs 'Codeshi.lnk'))
    $link.TargetPath = Join-Path $dest $exe
    $link.WorkingDirectory = $dest
    $link.Description = 'Codeshi'
    $link.Save()

    # The copy and shortcut from before the rename go. Workspaces and settings are kept in their own folder.
    if ((Test-Path (Join-Path $legacy 'Throughline.exe')) -and $legacy -ne $dest) { Remove-Item -Recurse -Force $legacy; $replaced = $true }
    $oldShortcut = Join-Path $programs 'Throughline.lnk'
    if (Test-Path $oldShortcut) { Remove-Item -Force $oldShortcut; $replaced = $true }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  Write-Host "Installed Codeshi $version in $dest."
  if ($replaced) { Write-Host 'Codeshi was called Throughline, so it replaced Throughline. Your workspaces and settings are kept. If Throughline was pinned to the taskbar, pin Codeshi instead.' }
  Write-Host 'Open it from the Start menu, or run:' "& '$(Join-Path $dest $exe)'"
  Write-Host 'Codeshi uses Claude Code and/or the Codex CLI, installed and signed in with your own accounts.'
}
