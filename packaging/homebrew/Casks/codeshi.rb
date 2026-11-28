# Cask for the personal tap AhmedNavaz/homebrew-codeshi (copy this file to Casks/codeshi.rb in that repo).
# Install: brew tap AhmedNavaz/codeshi && brew install --cask codeshi
# Checksums come from the release's SHA256SUMS.txt. Update version and both sha256 values per release.
cask "codeshi" do
  version "0.64.0"

  on_arm do
    sha256 "dde075b6631878bd773633b99d06882cc5fb9a73aad02ec50f8b0536e395bb6e"
    url "https://github.com/AhmedNavaz/codeshi/releases/download/v#{version}/Codeshi-#{version}-mac-apple-silicon.zip"
  end
  on_intel do
    sha256 "6775dc41cb94d0315b98f726642bbb9e536b323a94f797c077c978ba8c0e8a49"
    url "https://github.com/AhmedNavaz/codeshi/releases/download/v#{version}/Codeshi-#{version}-mac-intel.zip"
  end

  name "Codeshi"
  desc "Claude Code, Codex, Gemini and local models in one conversation"
  homepage "https://codeshi.dev"

  app "Codeshi.app"

  zap trash: [
    "~/.local/share/throughline",
    "~/Library/Application Support/AI Relay",
    "~/Library/Application Support/Codeshi",
    "~/Library/Application Support/Throughline",
    "~/Library/Caches/local.throughline.desktop",
    "~/Library/Preferences/local.throughline.desktop.plist",
    "~/Library/Saved Application State/local.throughline.desktop.savedState",
  ]
end
