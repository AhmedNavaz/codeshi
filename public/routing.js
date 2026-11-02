// Auto (#12): picks the agent, model and reasoning effort for each message. It uses simple local rules, never a model
// call, so it is instant, free and predictable, and the choice is shown before anything is sent. The page sends the
// exact choice it showed, and the person can always pick a model themselves instead.
//
// Loaded as a plain script in the page and as a module in tests: the page reads window.relayRouting, tests globalThis.
(root => {
  'use strict';
  const MODES = ['saving', 'balanced', 'quality'];
  const modeNames = { saving: 'Cost saving', balanced: 'Balanced', quality: 'Maximum quality' };
  const agentNames = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const TIERS = ['light', 'standard', 'deep'];

  // Work that needs the strongest reasoning, named so the reason can say what was recognised.
  const deepSignals = [
    [/\barchitect(ure|ural)?\b|\bsystem design\b|\bdesign (a|the|an) (new )?(system|service|api|schema)\b/, 'architecture'],
    [/\brefactor(ing)?\b|\brestructur(e|ing)\b|\brewrite\b/, 'refactoring'],
    [/\bmigrat(e|ion|ing)\b|\bupgrade\b.*\b(framework|version|major)\b/, 'a migration'],
    [/\brace condition|\bdeadlock|\bconcurren(cy|t)\b|\bthread[- ]safe/, 'concurrency'],
    [/\bmemory leak|\bperformance\b|\boptimi[sz](e|ation)\b|\bslow(ness)?\b|\blatency\b/, 'performance'],
    [/\bsecurity\b|\bvulnerab|\bxss\b|\binjection\b|\bauth(entication|orization)?\b|\bencrypt/, 'security'],
    [/\broot cause\b|\binvestigate\b|\bflaky\b|\bintermittent\b|\bheisenbug\b|\bdebug(ging)?\b/, 'debugging'],
    [/\bfrom scratch\b|\bend[- ]to[- ]end\b|\bacross (the )?(whole |entire )?(code ?base|project|repo)\b|\bevery (file|module|component)\b/, 'a broad change'],
  ];
  // Small, well-defined work a light model handles well.
  const lightSignals = /\b(rename|typo|spelling|reword|format(ting)?|lint|indent(ation)?|comment|docstring|readme|changelog|bump|version number|log message|copy ?edit|one[- ]line|small|quick|tiny|minor|simple)\b/;
  const questionStart = /^(what|where|which|who|when|how (do|does|can|to)|is|are|does|do|can|could|explain|show me|list)\b/;

  // How demanding a message looks: light, standard or deep, with a short reason.
  function classify(text, { attachments = 0 } = {}) {
    const value = String(text || '').trim(), lower = value.toLowerCase();
    const steps = (value.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm) || []).length;
    const paths = new Set(lower.match(/[\w.-]+\/[\w./-]+|\b[\w-]+\.(js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|css|html|json|md|yml|yaml|sql)\b/g) || []).size;
    for (const [pattern, name] of deepSignals) if (pattern.test(lower)) return { tier: 'deep', reason: `a complex task (${name})` };
    if (value.length > 1500 || steps >= 5 || paths >= 5) return { tier: 'deep', reason: 'a large, multi-part task' };
    if (value.length <= 300 && steps < 2 && paths <= 2 && !attachments) {
      if (lightSignals.test(lower)) return { tier: 'light', reason: 'a small, well-defined change' };
      if (questionStart.test(lower) && !/\b(why|bug|error|fail|broken|crash)\b/.test(lower)) return { tier: 'light', reason: 'a quick question' };
    }
    return { tier: 'standard', reason: 'a focused change' };
  }

  // A model's tier from its name: mini, haiku, flash and lite models are light; opus, pro, max and ultra are deep.
  function modelTier(row) {
    const name = `${row.id || row.model || row.value || ''} ${row.displayName || row.name || ''}`.toLowerCase();
    if (/\b(mini|nano|haiku|lite|flash|fast|small|spark)\b/.test(name)) return 'light';
    if (/\b(opus|pro|max|ultra|heavy)\b/.test(name)) return 'deep';
    return 'standard';
  }
  const modelId = row => row.id || row.model || row.value || '';
  const effortsOf = row => (row?.supportedEffortLevels || row?.supportedReasoningEfforts?.map(level => level.reasoningEffort) || []).filter(level => EFFORTS.includes(level)).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));

  // The model tier and effort each mode uses for each kind of task.
  const plan = {
    saving: { light: ['light', 'low'], standard: ['standard', 'low'], deep: ['standard', 'medium'] },
    balanced: { light: ['light', 'low'], standard: ['standard', 'medium'], deep: ['deep', 'high'] },
    quality: { light: ['standard', 'medium'], standard: ['deep', 'high'], deep: ['deep', 'highest'] },
  };

  // The agent's model closest to the wanted tier, preferring its default within a tier.
  function pickModel(rows, tier) {
    const usable = (rows || []).filter(row => modelId(row) && modelId(row) !== 'default' && !row.hidden);
    if (!usable.length) return null;
    const distance = row => Math.abs(TIERS.indexOf(modelTier(row)) - TIERS.indexOf(tier));
    return usable.reduce((best, row) => {
      if (!best) return row;
      const a = distance(row), b = distance(best);
      return a < b || a === b && row.isDefault && !best.isDefault ? row : best;
    }, null);
  }
  // The supported level closest to the wanted one; "highest" takes the top level.
  function pickEffort(levels, wanted) {
    if (!levels.length) return null;
    if (wanted === 'highest') return levels.at(-1);
    const target = EFFORTS.indexOf(wanted);
    return levels.reduce((best, level) => Math.abs(EFFORTS.indexOf(level) - target) < Math.abs(EFFORTS.indexOf(best) - target) ? level : best, levels[0]);
  }

  // One step stronger than a choice, for a retry after failed tests (#12, stage 2): the same agent, so it keeps its
  // session, with a stronger model or more effort. Null when the choice is already the agent's strongest.
  const LADDER = [['light', 'low'], ['standard', 'medium'], ['deep', 'high'], ['deep', 'highest']];
  function escalate(provider, rows, choice) {
    const current = (rows || []).find(row => modelId(row) === choice.model);
    if (!current) return null;
    const tier = TIERS.indexOf(modelTier(current)), effort = choice.effort ? EFFORTS.indexOf(choice.effort) : -1;
    for (const [wantedTier, wantedEffort] of LADDER) {
      const model = pickModel(rows, wantedTier);
      if (!model) continue;
      const level = pickEffort(effortsOf(model), wantedEffort), stepTier = TIERS.indexOf(modelTier(model)), stepEffort = level ? EFFORTS.indexOf(level) : -1;
      if (stepTier > tier || stepTier === tier && stepEffort > effort) return { provider, model: modelId(model), modelName: model.displayName || model.name || modelId(model), effort: level, tier: TIERS[stepTier] };
    }
    return null;
  }

  // Chooses for one message. candidates: [{ provider, models, billingSource, usedPercent, eligible }].
  // Only eligible agents are chosen; without allowApi, only agents billed to a subscription. An agent at 95% of a
  // limit is skipped, and the agent that did the last run is preferred, so the conversation keeps its native session.
  function route({ text, attachments = 0, mode = 'balanced', candidates = [], current = null, allowApi = false }) {
    if (!MODES.includes(mode)) mode = 'balanced';
    const task = classify(text, { attachments });
    const [tier, wantedEffort] = plan[mode][task.tier];
    const skipped = [];
    const pool = candidates.filter(candidate => {
      if (!candidate.eligible) return false;
      if (!allowApi && candidate.billingSource !== 'subscription') { skipped.push(`${agentNames[candidate.provider]} isn’t billed to a subscription`); return false; }
      if (Number.isFinite(candidate.usedPercent) && candidate.usedPercent >= 95) { skipped.push(`${agentNames[candidate.provider]} is at ${Math.round(candidate.usedPercent)}% of its limit`); return false; }
      return true;
    });
    if (!pool.length) return { error: `Auto found no connected agent within your rules${skipped.length ? ` (${skipped.join('; ')})` : ''}. Choose a model yourself, or allow API-billed agents.`, task, mode };
    // The agent is chosen by allowance and continuity, not by model names: each agent's own strongest model serves
    // complex work, so a vendor is never preferred just because its model is called "pro" or "opus".
    const score = candidate => {
      const used = Number.isFinite(candidate.usedPercent) ? candidate.usedPercent : 50;
      const usage = mode === 'saving' ? used : mode === 'balanced' ? (used >= 80 ? 100 + used : used / 4) : (used >= 90 ? 100 + used : 0);
      return usage - (candidate.provider === current ? 15 : 0);
    };
    const order = ['codex', 'claude', 'gemini'];
    const chosen = [...pool].sort((a, b) => score(a) - score(b) || order.indexOf(a.provider) - order.indexOf(b.provider))[0];
    const model = pickModel(chosen.models, tier), effort = pickEffort(effortsOf(model), wantedEffort);
    const why = [task.reason[0].toUpperCase() + task.reason.slice(1)];
    if (current && chosen.provider !== current) {
      const before = candidates.find(candidate => candidate.provider === current);
      why.push(!before?.eligible || !pool.includes(before) ? `${agentNames[current]} isn’t available under your rules` : Number.isFinite(before.usedPercent) && before.usedPercent >= 80 ? `${agentNames[current]} is at ${Math.round(before.usedPercent)}% of its limit` : `${agentNames[chosen.provider]} has more allowance left`);
    }
    const choice = { provider: chosen.provider, model: model ? modelId(model) : null, modelName: model ? (model.displayName || model.name || modelId(model)) : null, effort, tier: task.tier, mode, reason: why.join(' · ') };
    return { ...choice, escalation: escalate(chosen.provider, chosen.models, choice) };
  }

  root.relayRouting = { MODES, modeNames, classify, modelTier, route, escalate };
})(typeof window === 'undefined' ? globalThis : window);
