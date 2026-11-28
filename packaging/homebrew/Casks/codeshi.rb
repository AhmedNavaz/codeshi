# Cask for the personal tap AhmedNavaz/homebrew-codeshi (copy this file to Casks/codeshi.rb in that repo).
# Install: brew tap AhmedNavaz/codeshi && brew trust AhmedNavaz/codeshi && brew install --cask codeshi
# Checksums come from the release's SHA256SUMS.txt. Update version and both sha256 values per release.
cask "codeshi" do
  version "0.65.1"

  on_arm do
    sha256 "73261882cd3f5400c60101cc7080c37e524486eb823d5d93bacff11aa226ddcc"

    url "https://github.com/AhmedNavaz/codeshi/releases/download/v#{version}/Codeshi-#{version}-mac-apple-silicon.zip"
  end
  on_intel do
    sha256 "b867b58ce283b741d49277514c62494defed5ea92c4b26b579fc4e99e240dc8b"

    url "https://github.com/AhmedNavaz/codeshi/releases/download/v#{version}/Codeshi-#{version}-mac-intel.zip"
  end

  name "Codeshi"
  desc "Claude Code, Codex, Gemini and local models in one conversation"
  homepage "https://codeshi.dev/"

  depends_on :macos

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
