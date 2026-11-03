import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON } from './patches.mjs';

// Approvals a person chose to remember for a workspace (#68). Each rule allows one exact action again, as described by
// approvalScope: the agent, the exact command and its folder, or the exact file to edit. Rules live in the workspace's
// own data folder, so other workspaces and imported conversations never inherit them, and they can be revoked.
export class PermissionRules {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'permissions.json');
    this.rules = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved?.rules)) this.rules = saved.rules.filter(rule => rule && typeof rule.key === 'string' && typeof rule.id === 'string');
    } catch (error) { if (error.code !== 'ENOENT') console.error('Codeshi could not read saved permission rules:', error.message); }
  }
  save() { atomicJSON(this.file, { rules: this.rules }); }
  find(key) { return this.rules.find(rule => rule.key === key) || null; }
  list() { return this.rules.map(({ key, ...rule }) => rule); }
  remember(scope, provider) {
    const existing = this.find(scope.key);
    if (existing) return existing;
    const rule = { id: randomUUID(), key: scope.key, provider, kind: scope.kind, label: scope.label, ...(scope.cwd ? { cwd: scope.cwd } : {}), ...(scope.path ? { path: scope.path } : {}), createdAt: new Date().toISOString(), lastUsedAt: null, uses: 0 };
    this.rules.push(rule); this.save();
    return rule;
  }
  used(rule) { rule.lastUsedAt = new Date().toISOString(); rule.uses = (rule.uses || 0) + 1; try { this.save(); } catch {} }
  revoke(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter(rule => rule.id !== id);
    if (this.rules.length === before) throw Object.assign(new Error('This rule was already removed.'), { status: 404 });
    this.save();
  }
  reset() { this.rules = []; this.save(); }
}
