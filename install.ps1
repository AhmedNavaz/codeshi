# Installs the latest Throughline release on Windows:
#   irm https://raw.githubusercontent.com/AhmedNavaz/throughline/main/install.ps1 | iex
# $env:THROUGHLINE_VERSION = '0.16.0' installs a specific version. $env:THROUGHLINE_INSTALL_DIR changes the folder that
# holds the Throughline folder (default %LOCALAPPDATA%\Programs).
# Run as a script block so a failure ends the installer, not the PowerShell window it was pasted into.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell downloads far more slowly while it draws a progress bar.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'AhmedNavaz/throughline'
  function Fail([string]$message) { throw "throughline: $message" }

  if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Throughline needs 64-bit Windows.' }

  $version = $env:THROUGHLINE_VERSION
  if (-not $version) {
    try { $version = (Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest").tag_name }
    catch { Fail 'Could not reach GitHub.' }
  }
  $version = "$version" -replace '^v', ''
  if ($version -notmatch '^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$') { Fail 'Could not find the latest release.' }

  $parent = if ($env:THROUGHLINE_INSTALL_DIR) { $env:THROUGHLINE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs' }
  $dest = Join-Path $parent 'Throughline'
  if (Get-Process -Name 'Throughline' -ErrorAction SilentlyContinue) { Fail 'Quit Throughline, then run the installer again.' }

  $file = "Throughline-$version-windows-x64.zip"
  $base = "https://github.com/$repo/releases/download/v$version"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('throughline-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading Throughline $version for Windows..."
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $tmp $file) } catch { Fail "Could not download $file." }
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile (Join-Path $tmp 'SHA256SUMS.txt') } catch { Fail 'Could not download the checksums.' }
    $expected = $null
    foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS.txt')) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2] -eq $file) { $expected = $Matches[1].ToLowerInvariant() }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $file)).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) { Fail 'The download does not match its published checksum. Nothing was installed.' }

    Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath (Join-Path $tmp 'app')
    $app = Join-Path $tmp 'app\Throughline'
    if (-not (Test-Path (Join-Path $app 'Throughline.exe'))) { Fail 'The download does not contain Throughline.exe.' }
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    # Copied rather than moved, so a folder on another drive works too.
    Copy-Item -Recurse -Path $app -Destination $dest

    # Throughline adds its app ID to this shortcut when it starts, which Windows needs to show its notifications.
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Throughline.lnk'
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    $link.TargetPath = Join-Path $dest 'Throughline.exe'
    $link.WorkingDirectory = $dest
    $link.Description = 'Throughline'
    $link.Save()
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  Write-Host "Installed Throughline $version in $dest."
  Write-Host 'Open it from the Start menu, or run:' "& '$(Join-Path $dest 'Throughline.exe')'"
  Write-Host 'Throughline uses Claude Code and/or the Codex CLI, installed and signed in with your own accounts.'
}
