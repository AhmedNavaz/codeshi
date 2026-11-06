import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeConfigPath, claudePlanName, readClaudeProfile } from '../src/claude-plan.mjs';

// Claude Code's `auth status` says "pro" for a Max account; the profile in its config says Max, and the tier says 5x.
test('the plan name prefers the rate-limit tier, then the organization type, then the CLI’s own word', () => {
  assert.equal(claudePlanName({ subscriptionType: 'pro', organizationType: 'claude_max', rateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(claudePlanName({ subscriptionType: 'pro', organizationType: 'claude_max', rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(claudePlanName({ subscriptionType: 'pro', organizationType: 'claude_max' }), 'Max', 'The organization outranks the CLI’s word.');
  assert.equal(claudePlanName({ subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' }), 'Pro');
  assert.equal(claudePlanName({ subscriptionType: 'pro' }), 'Pro');
  assert.equal(claudePlanName({ subscriptionType: 'max' }), 'Max');
  assert.equal(claudePlanName({ organizationType: 'claude_team', rateLimitTier: 'custom_tier_7' }), 'Team', 'An unfamiliar tier is not guessed at.');
  assert.equal(claudePlanName({ organizationType: 'claude_enterprise' }), 'Enterprise');
  assert.equal(claudePlanName({ organizationType: 'unknown_type', rateLimitTier: '' }), null);
  assert.equal(claudePlanName({}), null);
  assert.equal(claudePlanName({ subscriptionType: 'x'.repeat(300) }), 'X' + 'x'.repeat(119), 'A long value is cut, not shown whole.');
});

test('the profile comes from Claude Code’s own config, with the user’s tier before the organization’s, and nothing secret', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-claude-plan-'));
  assert.equal(claudeConfigPath({ env: {}, home }), path.join(home, '.claude.json'));
  assert.equal(claudeConfigPath({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' }, home }), path.join('/elsewhere', '.claude.json'), 'CLAUDE_CONFIG_DIR moves the config.');
  assert.equal(readClaudeProfile({ env: {}, home }), null, 'No config yet.');
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  assert.equal(readClaudeProfile({ env: {}, home }), null, 'A broken config is not an error.');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'u', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x', userRateLimitTier: null } }));
  assert.deepEqual(readClaudeProfile({ env: {}, home }), { organizationType: 'claude_max', rateLimitTier: 'default_claude_max_5x' });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_team', organizationRateLimitTier: 'default_claude_team', userRateLimitTier: 'default_claude_max_20x' } }));
  assert.deepEqual(readClaudeProfile({ env: {}, home }), { organizationType: 'claude_team', rateLimitTier: 'default_claude_max_20x' }, 'The user’s own tier comes first.');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: 'nope' }));
  assert.equal(readClaudeProfile({ env: {}, home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});
