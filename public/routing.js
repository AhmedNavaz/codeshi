// Auto (#12): on Send, a local check settles what needs no reading (triage), a short agent assessment rates the rest, and
// the final choice uses that difficulty, the supported model/effort levels and account-wide quota evidence. Manual choices
// skip all of it. classify is the local estimate the page uses before Send, and the fallback when an assessment fails.
//
// Loaded as a plain script in the page and as a module in tests: the page reads window.relayRouting, tests globalThis.
(root => {
  'use strict';
  const MODES = ['saving', 'balanced', 'quality'];
  const modeNames = { saving: 'Cost saving', balanced: 'Balanced', quality: 'Maximum quality' };
  const handoffThresholds = Object.freeze({ saving: 80, balanced: 90, quality: 95 });
  const agentNames = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const TIERS = ['light', 'standard', 'deep'];

  // Shared by the page, task budgets, handoff and retries. Each applicable window constrains the selected model;
  // short-window room never cancels a weekly/model limit. Missing observation times are not evidence of fresh room.
  const windowApplies = (row, model) => {
    const name = String(model || '').toLowerCase();
    return Array.isArray(row.scopes) ? row.scopes.some(scope => typeof scope === 'string' && name.includes(scope.toLowerCase())) : !row.scope || name.includes(String(row.scope).toLowerCase());
  };
  function assessQuota(usage, model = null, { now = Date.now(), threshold = 90, staleMs = 15 * 60 * 1000 } = {}) {
    model ||= usage?.defaultModel || null;
    const all = (usage?.available && Array.isArray(usage.windows) ? usage.windows : []).filter(row => row && !row.disabled);
    const unresolvedModel = !model && all.some(row => row.scope || row.scopes?.length);
    const rows = all.filter(row => windowApplies(row, model));
    const rawTime = usage?.checkedAt ?? usage?.observedAt ?? usage?.fetchedAt;
    const time = typeof rawTime === 'number' ? rawTime : Date.parse(rawTime), age = now - time;
    const observedAt = Number.isFinite(time) ? new Date(time).toISOString() : null;
    const old = Number.isFinite(time) && (age > staleMs || age < -60000);
    const windows = rows.map(row => {
      const usedPercent = Number.isFinite(row.usedPercent) && row.usedPercent >= 0 ? row.usedPercent : null;
      const resetPassed = row.resetsAt && Date.parse(row.resetsAt) <= now;
      return { label: row.label || row.id || 'Plan limit', usedPercent, resetsAt: row.resetsAt || null,
        ...(row.scope ? { scope: row.scope } : {}), ...(Array.isArray(row.scopes) ? { scopes: row.scopes } : {}),
        state: old || resetPassed ? 'stale' : usedPercent === null ? 'unknown' : usedPercent >= 100 ? 'exhausted' : usedPercent >= threshold ? 'near' : 'ok' };
    });
    const state = windows.some(row => row.state === 'exhausted') ? 'exhausted' : old || windows.some(row => row.state === 'stale') ? 'stale'
      : unresolvedModel || !observedAt || !windows.length || windows.some(row => row.state === 'unknown') ? 'unknown' : windows.some(row => row.state === 'near') ? 'near' : 'ok';
    return { state, windows, observedAt, usedPercent: ['ok', 'near', 'exhausted'].includes(state) ? Math.max(...windows.map(row => row.usedPercent ?? 0)) : null,
      ...(['unknown', 'stale'].includes(state) ? { reason: state === 'stale' ? 'Usage needs a fresh reading.' : usage?.reason || 'Fresh plan usage is not reported for this model.' } : {}) };
  }
  const quotaText = quota => !quota || ['unknown', 'stale'].includes(quota.state) ? `Plan usage ${quota?.state || 'unknown'}${quota?.reason ? ': ' + quota.reason : ''}`
    : quota.windows.map(row => `${row.label}: ${Math.round(row.usedPercent)}% used`).join('; ');

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
  function classify(text, { attachments = 0, context = null } = {}) {
    const value = String(text || '').trim(), lower = value.toLowerCase();
    if (context && value.length <= 400 && /^(?:yes\b|ok(?:ay)?\b|go ahead\b|do (?:it|that|this)\b|continue\b|carry on\b|(?:now )?(?:implement|fix|finish) (?:it|that|this|the above)\b|(?:also|and|then)\b)/i.test(value) && !lightSignals.test(lower)) {
      const previous = classify(String(context).slice(-4000), { attachments });
      return { ...previous, reason: `continuing ${previous.reason}` };
    }
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

  // What Send can settle without asking an agent. Judging a request takes a model: keyword rules agreed with an agent on
  // barely half of real prompts. So this covers only what needs no judging, a bare go-ahead that carries on work already
  // rated, and anything else returns null. A go-ahead after light work is assessed too: what it approves may be bigger.
  const agreement = 'yes|yep|yeah|yup|sure';
  const filler = `${agreement}|ok|okay|please|now|then`;
  const proceed = 'go|go ahead|go on|go for it|do it|do that|do this|do so|do them|do both|continue|carry on|keep going|proceed|start|start it|implement it|implement that|implement this|fix it|fix that|fix this|fix them|fix both|finish it|finish that|apply it|apply that';
  const goAhead = new RegExp(`^(?:(?:(?:${filler})[\\s,.!;-]+)*(?:${proceed})(?:[\\s,.!;-]+(?:${filler}))*|(?:${agreement})(?:[\\s,.!;-]+(?:please|now))?)[\\s,.!]*$`);
  function triage(text, { attachments = 0, previous = null } = {}) {
    if (attachments || !previous || !['standard', 'deep'].includes(previous.tier) || !goAhead.test(String(text || '').trim().toLowerCase())) return null;
    return { tier: previous.tier, effort: ['low', 'medium', 'high'].includes(previous.effort) ? previous.effort : previous.tier === 'deep' ? 'high' : 'medium', reason: 'Continuing the same task', source: 'local' };
  }

  // A model's tier from its name: mini, haiku, flash and lite models are light; opus, pro, max and ultra are deep. A name
  // that says neither may still say what it is for in its catalog description, as "Fast and affordable" does.
  function modelTier(row) {
    const name = `${row.id || row.model || row.value || ''} ${row.displayName || row.name || ''}`.toLowerCase();
    if (/\b(mini|nano|haiku|lite|flash|fast|small|spark)\b/.test(name)) return 'light';
    if (/\b(opus|pro|max|ultra|heavy)\b/.test(name)) return 'deep';
    return /\b(fast|fastest|affordable|cheap|cheapest)\b/.test(String(row.description || '').toLowerCase()) ? 'light' : 'standard';
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

  // Chooses for one message. candidates: [{ provider, models, billingSource, usage, eligible, allowedModels }].
  // Only eligible agents are chosen; without allowApi, only agents billed to a subscription. An agent at 95% of a
  // limit is skipped, and the agent that did the last run is preferred, so the conversation keeps its native session.
  function route({ text, attachments = 0, context = null, assessment = null, mode = 'balanced', candidates = [], current = null, allowApi = false, quotaThreshold = 95, now = Date.now() }) {
    if (!MODES.includes(mode)) mode = 'balanced';
    const task = assessment && TIERS.includes(assessment.tier) && typeof assessment.reason === 'string' ? assessment : classify(text, { attachments, context });
    const [tier, baseEffort] = plan[mode][task.tier];
    const wantedEffort = mode === 'balanced' && ['low', 'medium', 'high'].includes(task.effort) && EFFORTS.indexOf(task.effort) > EFFORTS.indexOf(baseEffort) ? task.effort : baseEffort;
    const skipped = [];
    const pool = candidates.flatMap(candidate => {
      if (!candidate.eligible) return [];
      if (!allowApi && candidate.billingSource !== 'subscription') { skipped.push(`${agentNames[candidate.provider]} isn’t billed to a subscription`); return []; }
      const rows = (candidate.models || []).filter(row => !candidate.allowedModels || candidate.allowedModels.includes(modelId(row)));
      const preferred = pickModel(rows, tier);
      if (candidate.allowedModels && !preferred) { skipped.push(`${agentNames[candidate.provider]} has no model allowed by task limits`); return []; }
      // Try equivalent-tier models before ruling out the agent; never downgrade solely to escape a model's limit.
      const distance = row => Math.abs(TIERS.indexOf(modelTier(row)) - TIERS.indexOf(tier));
      const options = preferred ? [preferred, ...rows.filter(row => row !== preferred && modelId(row) !== 'default' && !row.hidden && distance(row) === distance(preferred))] : [null];
      const choices = options.map(model => ({ ...candidate, selectedModel: model, quota: assessQuota(candidate.usage, model && modelId(model), { threshold: quotaThreshold, now }) }));
      const usable = choices.filter(row => !['exhausted', 'near', 'stale'].includes(row.quota.state));
      if (!usable.length) { skipped.push(`${agentNames[candidate.provider]}: ${quotaText(choices[0].quota)}`); return []; }
      return usable;
    });
    if (!pool.length) return { error: `Auto found no connected agent within your rules${skipped.length ? ` (${skipped.join('; ')})` : ''}. Refresh plan usage or choose a model yourself. API-billed agents need separate consent.`, task, mode };
    // The agent is chosen by allowance and continuity, not by model names: each agent's own strongest model serves
    // complex work, so a vendor is never preferred just because its model is called "pro" or "opus".
    // Use the reset of the constraining window, never a short-window reset that hides a tighter weekly/model limit.
    // This is a bounded preference for usable allowance that expires sooner, not a prediction of task duration or tokens.
    const resetBonus = candidate => {
      const rows = candidate.quota.windows.filter(row => row.usedPercent >= candidate.quota.usedPercent - 5);
      if (!rows.length || rows.some(row => !Number.isFinite(Date.parse(row.resetsAt)))) return 0;
      const hours = Math.max(...rows.map(row => (Date.parse(row.resetsAt) - now) / 3600000));
      return hours > 0 ? 20 / (1 + hours / 6) : 0;
    };
    const score = candidate => {
      if (candidate.quota.state !== 'ok') return 1000 - (candidate.provider === current ? 15 : 0);
      const used = candidate.quota.usedPercent;
      const usage = mode === 'saving' ? used : mode === 'balanced' ? (used >= 80 ? 100 + used : used / 4) : (used >= 90 ? 100 + used : 0);
      const headroom = mode === 'saving' ? 0 : Math.max(0, used - 70) * (task.tier === 'deep' ? 2 : 0);
      return usage + headroom - resetBonus(candidate) - (candidate.provider === current ? 15 : 0);
    };
    const order = ['codex', 'claude', 'gemini'];
    const chosen = [...pool].sort((a, b) => score(a) - score(b) || order.indexOf(a.provider) - order.indexOf(b.provider))[0];
    const model = chosen.selectedModel, effort = pickEffort(effortsOf(model), wantedEffort);
    const why = [task.reason[0].toUpperCase() + task.reason.slice(1)];
    if (current && chosen.provider !== current) {
      const before = candidates.find(candidate => candidate.provider === current);
      const previous = pool.find(candidate => candidate.provider === current);
      why.push(!before?.eligible || !previous ? `${agentNames[current]} isn’t available under your rules` : previous.quota.usedPercent >= 80 ? `${agentNames[current]} is at ${Math.round(previous.quota.usedPercent)}% of its limit` : previous.quota.state !== 'ok' ? `${agentNames[current]} has no confirmed allowance` : resetBonus(chosen) > resetBonus(previous) + 10 ? `${agentNames[chosen.provider]}'s usable allowance resets sooner` : task.tier === 'deep' ? `${agentNames[chosen.provider]} has more room for demanding work` : `${agentNames[chosen.provider]} has more allowance left`);
    }
    const choice = { provider: chosen.provider, model: model ? modelId(model) : null, modelName: model ? (model.displayName || model.name || modelId(model)) : null, effort, tier: task.tier, mode, reason: why.join(' · ') };
    return { ...choice, ...(assessment ? { assessment: task } : {}), quota: chosen.quota, escalation: escalate(chosen.provider, chosen.models, choice) };
  }

  // The same choice when the agent is already decided: a queued prompt that moved at a handoff is routed again for the
  // agent that took over (#93). Null when that agent lists no models, so the caller keeps its own choice.
  function routeTo(provider, rows, { text, attachments = 0, assessment = null, mode = 'balanced' }) {
    if (!MODES.includes(mode)) mode = 'balanced';
    const task = assessment && TIERS.includes(assessment.tier) ? assessment : classify(text, { attachments }), [tier, wantedEffort] = plan[mode][task.tier], model = pickModel(rows, tier);
    if (!model) return null;
    const choice = { provider, model: modelId(model), modelName: model.displayName || model.name || modelId(model), effort: pickEffort(effortsOf(model), wantedEffort), tier: task.tier, mode, reason: task.reason[0].toUpperCase() + task.reason.slice(1) };
    return { ...choice, escalation: escalate(provider, rows, choice) };
  }

  root.relayRouting = { MODES, modeNames, handoffThresholds, classify, triage, modelTier, route, routeTo, escalate, assessQuota, quotaText, windowApplies };
})(typeof window === 'undefined' ? globalThis : window);
