import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Which Claude plan an account is on. Claude Code's `auth status` says "pro" for claude.ai accounts even on Max (seen on
// a Max 5x account), but the profile it keeps in its own config says which plan the organization is on, and the
// rate-limit tier says how much of it. The most specific reading wins; the CLI's own word is the last resort.
const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
const title = word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

export function claudeConfigPath({ env = process.env, home = os.homedir() } = {}) {
  return path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
}
// The account profile from Claude Code's config, or null when there is none to read. Nothing secret is kept.
export function readClaudeProfile(options = {}) {
  try {
    const account = JSON.parse(fs.readFileSync(claudeConfigPath(options), 'utf8'))?.oauthAccount;
    if (!account || typeof account !== 'object') return null;
    return { organizationType: text(account.organizationType), rateLimitTier: text(account.userRateLimitTier) || text(account.organizationRateLimitTier) };
  } catch { return null; }
}
// "Max 5x" from default_claude_max_5x, "Max" from claude_max, "Pro" from the CLI's pro; null when nothing says.
export function claudePlanName({ subscriptionType = null, organizationType = null, rateLimitTier = null } = {}) {
  const tier = /^(?:default_)?claude_(max|pro|team|enterprise|free)(?:_(\d+)x)?(?:_|$)/i.exec(text(rateLimitTier) || '');
  if (tier) return `${title(tier[1])}${tier[2] ? ` ${tier[2]}x` : ''}`;
  const organization = /^claude_(max|pro|team|enterprise|free)(?:_|$)/i.exec(text(organizationType) || '');
  if (organization) return title(organization[1]);
  const word = text(subscriptionType);
  return word ? title(word) : null;
}
