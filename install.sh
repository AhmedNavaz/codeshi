#!/bin/sh
# Installs the latest Codeshi release on macOS:
#   curl -fsSL https://raw.githubusercontent.com/AhmedNavaz/throughline/main/install.sh | sh
# CODESHI_VERSION=0.4.0 installs a specific version. CODESHI_INSTALL_DIR changes the folder (default /Applications).
# Codeshi was called Throughline: THROUGHLINE_VERSION and THROUGHLINE_INSTALL_DIR work too, and a Throughline.app in
# the same folder is replaced, keeping your workspaces and settings.
set -eu

repo="AhmedNavaz/throughline"

fail() { printf 'codeshi: %s\n' "$1" >&2; exit 1; }

main() {
  [ "$(uname -s)" = "Darwin" ] || fail "Codeshi is currently available for macOS only."

  # Reported by Apple Silicon hardware even when the terminal runs under Rosetta.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then build="apple-silicon"; name="Apple Silicon"; else build="intel"; name="Intel"; fi

  version="${CODESHI_VERSION:-${THROUGHLINE_VERSION:-}}"
  if [ -z "$version" ]; then
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") || fail "Could not reach GitHub."
    version=${latest##*/v}
  fi
  version=${version#v}
  case "$version" in ''|*/*) fail "Could not find the latest release." ;; esac

  folder="${CODESHI_INSTALL_DIR:-${THROUGHLINE_INSTALL_DIR:-}}"
  dest="${folder:-/Applications}"
  if [ -z "$folder" ] && [ ! -w "$dest" ]; then dest="$HOME/Applications"; fi
  mkdir -p "$dest"
  [ -w "$dest" ] || fail "Cannot write to $dest."
  # A copy updated from inside the app keeps its folder name, Throughline.app, until it is installed again.
  if pgrep -qf '/Codeshi\.app/Contents/MacOS/Codeshi' || pgrep -qf '/Throughline\.app/Contents/MacOS/'; then fail "Quit Codeshi, then run the installer again."; fi

  base="https://github.com/$repo/releases/download/v$version"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' INT TERM

  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fail "Could not download the checksums."
  # Releases from before the rename name their files after Throughline.
  expected=""
  for file in "Codeshi-$version-mac-$build.zip" "Throughline-$version-mac-$build.zip"; do
    expected=$(awk -v file="$file" '$2 == file { print $1 }' "$tmp/SHA256SUMS.txt")
    [ -n "$expected" ] && break
  done
  [ -n "$expected" ] || fail "Could not find Codeshi $version for $name Macs."

  printf 'Downloading Codeshi %s for %s Macs...\n' "$version" "$name"
  curl -fL --progress-bar -o "$tmp/$file" "$base/$file" || fail "Could not download $file."
  actual=$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }')
  if [ "$expected" != "$actual" ]; then fail "The download does not match its published checksum. Nothing was installed."; fi

  ditto -x -k "$tmp/$file" "$tmp/app"
  if [ -d "$tmp/app/Codeshi.app" ]; then app="$tmp/app/Codeshi.app"
  elif [ -d "$tmp/app/Throughline.app" ]; then app="$tmp/app/Throughline.app"
  else fail "The download does not contain Codeshi.app."; fi
  rm -rf "$dest/Codeshi.app"
  mv "$app" "$dest/Codeshi.app"

  printf 'Installed Codeshi %s in %s.\n' "$version" "$dest"
  if [ -d "$dest/Throughline.app" ]; then
    rm -rf "$dest/Throughline.app"
    printf 'Codeshi was called Throughline, so it replaced Throughline.app. Your workspaces and settings are kept.\n'
    printf 'If Throughline was in your Dock, remove it there and add Codeshi.\n'
  fi
  printf 'Open it with: open "%s/Codeshi.app"\n' "$dest"
  printf 'Codeshi uses Claude Code and/or the Codex CLI, installed and signed in with your own accounts.\n'
}

main "$@"
