# Cask for the personal tap AhmedNavaz/homebrew-codeshi (copy this file to Casks/codeshi.rb in that repo).
# Install: brew tap AhmedNavaz/codeshi && brew trust AhmedNavaz/codeshi && brew install --cask codeshi
# Checksums come from the release's SHA256SUMS.txt. Update version and both sha256 values per release.
cask "codeshi" do
  version "0.65.0"

  on_arm do
    sha256 "0ae92facedea568b265e45ce50ed3f7164e4c8c16edccef593cac467f0b519bf"

    url "https://github.com/AhmedNavaz/codeshi/releases/download/v#{version}/Codeshi-#{version}-mac-apple-silicon.zip"
  end
  on_intel do
    sha256 "1b86d07f02fbecb789d58170085fe73b3a3a6bd085017b75f9b2a426eddaac5a"

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
