// Auto (#12, #128): Smart, Saver and Ultra routing modes, spending allowance where it resets soonest.
// On Send, Saver uses local rules with light and standard models at low effort; Smart and Ultra run a short agent
// assessment (after local triage settles bare go-aheads) and choose by task need, model/effort support and window
// spendability. Manual choices skip all of it.
//
// Loaded as a plain script in the page and as a module in tests: the page reads window.relayRouting, tests globalThis.
(root => {
  'use strict';
  const MODES = ['saver', 'smart', 'ultra'];
  // Which version of these rules chose an agent. Smart results (#139) only compare tasks routed by the same version, so
  // raise it whenever route(), classify() or the mode plans change what gets chosen.
  const POLICY_VERSION = 1;
  const LEGACY_MODES = Object.freeze({ saving: 'saver', balanced: 'smart', quality: 'ultra' });
  const normalizeMode = mode => MODES.includes(mode) ? mode : LEGACY_MODES[mode] || null;
  const modeNames = { saver: 'Saver', smart: 'Smart', ultra: 'Ultra', saving: 'Saver', balanced: 'Smart', quality: 'Ultra' };
  const handoffThresholds = Object.freeze({ saver: 80, smart: 90, ultra: 95, saving: 80, balanced: 90, quality: 95 });
  const agentNames = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const TIERS = ['light', 'standard', 'deep'];

  // Shared by the page, task budgets, handoff and retries. Each applicable window constrains the selected model;
  // short-window room never cancels a weekly/model limit. Missing observation times are not evidence of fresh room.
  const windowApplies = (row, model) => {
    const name = String(model || '').toLowerCase();
    return Array.isArray(row.scopes) ? row.scopes.some(scope => typeof scope === 'string' && name.includes(scope.toLowerCase())) : !row.scope || name.includes(String(row.scope).toLowerCase());
  };

  function windowPeriodHours(row) {
    const label = `${row?.label || ''} ${row?.id || ''}`;
    if (/week|7[- ]?d/i.test(label)) return 168;
    if (/day|24[- ]?h|daily/i.test(label)) return 24;
    return 5;
  }

  function adaptiveThreshold(row, baseThreshold = 90, { now = Date.now(), workload = null, tier = null } = {}) {
    if (baseThreshold <= 0) return 0;
    const periodHours = windowPeriodHours(row);
    const resetMs = row?.resetsAt ? Date.parse(row.resetsAt) : NaN;
    const hasReset = Number.isFinite(resetMs) && resetMs > now;
    const hoursLeft = hasReset ? Math.max(0.1, (resetMs - now) / 3600000) : null;
    const expectedSpend = typeof workload === 'number' && Number.isFinite(workload) && workload > 0
      ? workload
      : (periodHours >= 168 ? (tier === 'deep' ? 3 : 2) : periodHours >= 24 ? 4 : (tier === 'deep' ? 8 : 5));

    if (hasReset && hoursLeft !== null) {
      if (periodHours >= 168) {
        if (hoursLeft <= 2 || hoursLeft / periodHours <= 0.05) {
          return Math.max(baseThreshold, Math.min(98, 100 - Math.max(2, expectedSpend)));
        }
        const timeFraction = Math.min(1, hoursLeft / periodHours);
        const buffer = Math.max(2.5, expectedSpend * (1 + timeFraction * 0.75));
        return Math.max(baseThreshold, Math.min(97, Math.round(100 - buffer)));
      }
      if (hoursLeft <= 0.5) {
        return Math.max(baseThreshold, Math.min(98, 100 - Math.max(2, expectedSpend)));
      }
    }
    return baseThreshold;
  }

  // How soon a window must reset for its leftover allowance to be spent rather than kept (#153). Mid-window, the safety
  // margin protects the days still to come; this close to a reset, what is left would only expire unused.
  const BURNDOWN_HOURS = { weekly: 6, daily: 2, short: 0.5 };
  function burndownHours(row) {
    const period = windowPeriodHours(row);
    return period >= 168 ? BURNDOWN_HOURS.weekly : period >= 24 ? BURNDOWN_HOURS.daily : BURNDOWN_HOURS.short;
  }

  function assessQuota(usage, model = null, { now = Date.now(), threshold = 90, staleMs = 15 * 60 * 1000, adaptive = true, workload = null, tier = null } = {}) {
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
      const effectiveThreshold = adaptive ? adaptiveThreshold(row, threshold, { now, workload, tier }) : threshold;
      return { id: row.id || null, label: row.label || row.id || 'Plan limit', usedPercent, resetsAt: row.resetsAt || null,
        ...(row.scope ? { scope: row.scope } : {}), ...(Array.isArray(row.scopes) ? { scopes: row.scopes } : {}),
        state: old || resetPassed ? 'stale' : usedPercent === null ? 'unknown' : usedPercent >= 100 ? 'exhausted' : usedPercent >= effectiveThreshold ? 'near' : 'ok' };
    });
    const state = windows.some(row => row.state === 'exhausted') ? 'exhausted' : old || windows.some(row => row.state === 'stale') ? 'stale'
      : unresolvedModel || !observedAt || !windows.length || windows.some(row => row.state === 'unknown') ? 'unknown' : windows.some(row => row.state === 'near') ? 'near' : 'ok';
    // Near its limit only in windows about to reset, with room in every other one: Auto may spend what is left (#153).
    const resetsIn = row => { const ms = row.resetsAt ? Date.parse(row.resetsAt) : NaN; return Number.isFinite(ms) && ms > now ? (ms - now) / 3600000 : null; };
    const nearRows = windows.filter(row => row.state === 'near');
    const expiring = state === 'near' && nearRows.every(row => resetsIn(row) !== null && resetsIn(row) <= burndownHours(row)) ? nearRows.reduce((last, row) => !last || Date.parse(row.resetsAt) > Date.parse(last.resetsAt) ? row : last, null) : null;
    return { state, windows, observedAt, usedPercent: ['ok', 'near', 'exhausted'].includes(state) ? Math.max(...windows.map(row => row.usedPercent ?? 0)) : null,
      ...(expiring ? { burndown: { label: expiring.label, resetsAt: expiring.resetsAt, remaining: Math.max(0, 100 - expiring.usedPercent) } } : {}),
      ...(['unknown', 'stale'].includes(state) ? { reason: state === 'stale' ? (usage?.timedOut ? 'Usage check timed out.' : (usage?.reason && usage.reason !== 'Usage needs a fresh reading.') ? usage.reason : 'Usage needs a fresh reading.') : usage?.reason || 'Fresh plan usage is not reported for this model.' } : {}) };
  }
  const quotaText = quota => !quota || ['unknown', 'stale'].includes(quota.state) ? `Plan usage ${quota?.state || 'unknown'}${quota?.reason ? ': ' + quota.reason : ''}`
    : quota.windows.map(row => `${row.label}: ${Math.round(row.usedPercent)}% used`).join('; ');

  // Values remaining allowance in a window by how long it has to last (#128). Allowance resetting within the hour is
  // nearly free to spend; weekly allowance with days to go is preserved. The tightest (binding) window on an agent
  // decides, so an early 5-hour reset never outweighs a tighter weekly window on the same agent.
  function windowSpendability(row, now = Date.now()) {
    const usedPercent = Number.isFinite(row?.usedPercent) ? row.usedPercent : 100;
    const remaining = Math.max(0, 100 - usedPercent);
    const resetMs = row?.resetsAt ? Date.parse(row.resetsAt) : NaN;
    const hasReset = Number.isFinite(resetMs) && resetMs > now;
    const hoursLeft = hasReset ? Math.max(0.1, (resetMs - now) / 3600000) : null;
    const periodHours = windowPeriodHours(row);
    const fraction = hasReset ? Math.min(1, Math.max(0.05, hoursLeft / periodHours)) : 1;
    const daysLeft = hasReset ? hoursLeft / 24 : 0;
    const denom = hasReset ? 0.25 + 0.75 * fraction + 0.25 * daysLeft : 1;
    const spendability = remaining > 0 ? remaining / denom : 0;
    return { ...row, usedPercent, remaining, hoursLeft, periodHours, spendability };
  }
  function bindingWindow(quota, now = Date.now()) {
    if (!quota?.windows?.length) return null;
    return quota.windows.map(row => windowSpendability(row, now)).reduce((tightest, row) => {
      if (!tightest) return row;
      if (Math.abs(row.spendability - tightest.spendability) > 1e-6) return row.spendability < tightest.spendability ? row : tightest;
      return row.usedPercent > tightest.usedPercent ? row : tightest;
    }, null);
  }
  function resetDayName(resetsAt, now = Date.now()) {
    const ms = resetsAt ? Date.parse(resetsAt) : NaN;
    if (!Number.isFinite(ms) || ms <= now) return null;
    const hours = (ms - now) / 3600000;
    if (hours < 1) return `in ${Math.max(1, Math.round(hours * 60))}m`;
    if (hours < 6) return `in ${Math.round(hours)}h`;
    return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  }

  // Says why an agent near its limit is still used (#153), for the run's reason and its activity row.
  function remainderText(provider, quota, { asked = false, now = Date.now() } = {}) {
    const name = agentNames[provider] || provider;
    const tightest = (quota?.windows || []).filter(row => row.state === 'near').reduce((top, row) => !top || row.usedPercent > top.usedPercent ? row : top, null);
    const row = !asked && quota?.burndown || tightest;
    if (!row) return `Spending ${name}'s remaining allowance${asked ? ' as you asked' : ''}`;
    const left = Math.max(0, Math.round(100 - (row.usedPercent ?? 100 - (row.remaining ?? 0)))), when = resetDayName(row.resetsAt, now);
    return asked
      ? `Spending ${name}'s remaining allowance as you asked (${row.label}: ${left}% left${when ? `, resets ${when}` : ''})`
      : `Spending ${name}'s remaining ${row.label} allowance (${left}% left) before it resets${when ? ` ${when}` : ''}`;
  }

  // Work that needs the strongest reasoning, named so the reason can say what was recognised.
  const deepSignals = [
    [/\barchitect(ure|ural)?\b|\bsystem design\b|\bdesign (a|the|an) (new )?(system|service|api|schema)\b/, 'architecture'],
    [/\brefactor(ing)?\b|\brestructur(e|ing)?\b|\brewrite\b/, 'refactoring'],
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

  // The model tier and effort each mode uses for each kind of task (#128):
  // - Saver: light and standard models at low effort.
  // - Smart: whole ladder from light/low through standard/medium to deep/high.
  // - Ultra: strongest models first, stepping down one tier only when no strong model has usable allowance.
  const plan = {
    saver: { light: ['light', 'low'], standard: ['standard', 'low'], deep: ['standard', 'low'] },
    smart: { light: ['light', 'low'], standard: ['standard', 'medium'], deep: ['deep', 'high'] },
    ultra: { light: ['deep', 'high'], standard: ['deep', 'high'], deep: ['deep', 'highest'] },
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

  // What a candidate usually spends on a standard or deep run in a given window (#128).
  function usualForWindow(candidate, row, tier) {
    const raw = candidate?.usualSpend ?? candidate?.usualPercent;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    if (!raw || typeof raw !== 'object') return null;
    const key = row?.id || row?.label || '';
    const isWeekly = /week|7[- ]?d/i.test(`${row?.label || ''} ${row?.id || ''}`);
    const value = raw.byWindow?.[key] ?? raw.byWindow?.[row?.label] ?? raw[key] ?? (isWeekly ? raw.weekly : raw.short) ?? raw.byTier?.[tier] ?? raw.usual ?? raw.percent ?? null;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }
  function checkUsualRoom(candidate, quota, tier, now) {
    if (!['standard', 'deep'].includes(tier) || !quota?.windows?.length) return null;
    for (const raw of quota.windows) {
      const row = windowSpendability(raw, now);
      const usual = usualForWindow(candidate, row, tier);
      if (usual !== null && row.remaining < usual) {
        return { window: row, remaining: row.remaining, usual, resetsSoon: row.hoursLeft !== null && row.hoursLeft <= 2 };
      }
    }
    return null;
  }

  // Chooses for one message. candidates: [{ provider, models, billingSource, usage, eligible, allowedModels, usualSpend }].
  // Only eligible agents are chosen; without allowApi, only agents billed to a subscription. An agent at 95% of a
  // limit is skipped, and allowance is spent where it resets soonest while respecting continuity.
  // allowNear: you chose "Proceed with remaining allowance", so an agent past the safety threshold but not at its limit
  // may still be chosen, after every agent with ordinary headroom.
  function route({ text, attachments = 0, context = null, assessment = null, mode = 'smart', candidates = [], current = null, allowApi = false, allowNear = false, quotaThreshold = 95, now = Date.now() }) {
    mode = normalizeMode(mode) || 'smart';
    const task = assessment && TIERS.includes(assessment.tier) && typeof assessment.reason === 'string' ? assessment : classify(text, { attachments, context });
    const [tier, baseEffort] = plan[mode][task.tier];
    const wantedEffort = mode === 'smart' && ['low', 'medium', 'high'].includes(task.effort) && EFFORTS.indexOf(task.effort) > EFFORTS.indexOf(baseEffort) ? task.effort : baseEffort;
    const skipped = [];
    const pool = candidates.flatMap(candidate => {
      if (!candidate.eligible) return [];
      if (!allowApi && candidate.billingSource !== 'subscription') { skipped.push(`${agentNames[candidate.provider]} isn’t billed to a subscription`); return []; }
      const rows = (candidate.models || []).filter(row => !candidate.allowedModels || candidate.allowedModels.includes(modelId(row)));
      const preferred = pickModel(rows, tier);
      if (candidate.allowedModels && !preferred) { skipped.push(`${agentNames[candidate.provider]} has no model allowed by task limits`); return []; }
      const distance = row => Math.abs(TIERS.indexOf(modelTier(row)) - TIERS.indexOf(tier));
      const options = preferred ? [preferred, ...rows.filter(row => row !== preferred && modelId(row) !== 'default' && !row.hidden && distance(row) === distance(preferred))] : [null];
      const decorate = (model, steppedDown = false, steppedDownFrom = null, steppedDownQuota = null) => {
        const quota = assessQuota(candidate.usage, model && modelId(model), { threshold: quotaThreshold, now, tier: task.tier, workload: usualForWindow(candidate, null, task.tier) });
        const binding = bindingWindow(quota, now);
        const shortRoom = checkUsualRoom(candidate, quota, task.tier, now);
        return { ...candidate, selectedModel: model, quota, bindingWindow: binding, shortRoom, steppedDown, steppedDownFrom, steppedDownQuota };
      };
      const choices = options.map(model => decorate(model));
      const usable = choices.filter(row => !['exhausted', 'near', 'stale'].includes(row.quota.state));
      if (usable.length) return usable;
      // Weekly and model-specific windows count separately (#128): an exhausted Opus weekly window leaves Claude
      // usable at the next tier down (never light for deep work), and Ultra steps down one tier when needed.
      let fallbackChoices = [];
      if (preferred) {
        const preferredTierIndex = TIERS.indexOf(modelTier(preferred));
        const nextTier = preferredTierIndex > 0 ? TIERS[preferredTierIndex - 1] : null;
        if (nextTier && !(task.tier === 'deep' && nextTier === 'light')) {
          const fallbackRows = rows.filter(row => modelId(row) && modelId(row) !== 'default' && !row.hidden && modelTier(row) === nextTier);
          const fallbackPreferred = pickModel(fallbackRows, nextTier);
          if (fallbackPreferred) {
            const fallbackOptions = [fallbackPreferred, ...fallbackRows.filter(row => row !== fallbackPreferred)];
            fallbackChoices = fallbackOptions.map(model => decorate(model, true, preferred, choices[0].quota));
            const fallbackUsable = fallbackChoices.filter(row => !['exhausted', 'near', 'stale'].includes(row.quota.state));
            if (fallbackUsable.length) return fallbackUsable;
          }
        }
      }
      // Past the safety margin but not at the limit, allowance is still spent rather than the work paused (#153): when
      // the window resets soon enough that it would expire unused, or when you chose "Proceed with remaining allowance".
      // The strongest model comes first; a tier down is tried before pausing.
      const spendable = row => row.quota.state === 'near' && (allowNear || Boolean(row.quota.burndown));
      const remaining = choices.filter(spendable);
      if (remaining.length) return remaining;
      const remainingBelow = fallbackChoices.filter(spendable);
      if (remainingBelow.length) return remainingBelow;
      skipped.push(`${agentNames[candidate.provider]}: ${quotaText(choices[0].quota)}`);
      return [];
    });
    if (!pool.length) return { error: `Auto found no connected agent within your rules${skipped.length ? ` (${skipped.join('; ')})` : ''}. Refresh plan usage or choose a model yourself. API-billed agents need separate consent.`, task, mode };

    // Rank by binding window spendability, continuity, full-tier availability and usual-run headroom (#128).
    const spendabilityOf = candidate => candidate.bindingWindow ? candidate.bindingWindow.spendability : Math.max(0, 100 - (candidate.quota.usedPercent ?? 100));
    const continuityBonus = candidate => {
      if (candidate.provider !== current) return 0;
      if (candidate.quota.state !== 'ok') return 15;
      if ((candidate.quota.usedPercent ?? 0) >= 80) return 0;
      if (candidate.shortRoom && !candidate.shortRoom.resetsSoon) return 0;
      const base = spendabilityOf(candidate);
      return Math.min(15, Math.max(4, base * 0.35));
    };
    const score = candidate => {
      // An agent near its limit comes last, and among those, the one with the most allowance left to spend: running out
      // partway costs more than starting a new session.
      if (candidate.quota.state === 'near') return -2000 + spendabilityOf(candidate);
      if (candidate.quota.state !== 'ok') return -1000 + continuityBonus(candidate);
      const stepPenalty = candidate.steppedDown ? 400 : 0;
      const roomPenalty = candidate.shortRoom && !candidate.shortRoom.resetsSoon ? 200 : 0;
      return spendabilityOf(candidate) + continuityBonus(candidate) - stepPenalty - roomPenalty;
    };
    const order = ['codex', 'claude', 'gemini'];
    const chosen = [...pool].sort((a, b) => score(b) - score(a) || order.indexOf(a.provider) - order.indexOf(b.provider))[0];
    // On the last of an allowance, the top effort level isn't used: it can spend the rest in one turn (#153).
    const spendingRemainder = chosen.quota.state === 'near';
    const model = chosen.selectedModel, effort = pickEffort(effortsOf(model), spendingRemainder && wantedEffort === 'highest' ? 'high' : wantedEffort);
    const plannedHandoff = Boolean(chosen.shortRoom);
    const why = [task.reason[0].toUpperCase() + task.reason.slice(1)];
    if (spendingRemainder) why.push(remainderText(chosen.provider, chosen.quota, { asked: allowNear && !chosen.quota.burndown, now }));

    // Explain stepping down one tier when a strong model's allowance was unavailable.
    if (chosen.steppedDown && chosen.steppedDownFrom && model) {
      const fromName = chosen.steppedDownFrom.displayName || chosen.steppedDownFrom.name || modelId(chosen.steppedDownFrom);
      const toName = model.displayName || model.name || modelId(model);
      why.push(`${fromName} has no usable allowance (${quotaText(chosen.steppedDownQuota)}), so stepping down one tier to ${toName}`);
    }

    // Explain the allowance / reset-timing logic in words (#128).
    const others = pool.filter(item => item.provider !== chosen.provider && item.quota.state === 'ok');
    const previous = current && chosen.provider !== current ? pool.find(item => item.provider === current) : null;
    const moreRemainingOther = others.find(item => (item.bindingWindow?.remaining ?? 0) > (chosen.bindingWindow?.remaining ?? 100));
    const compared = previous || moreRemainingOther || null;
    const explainAllowance = (target, other) => {
      const wTarget = target.bindingWindow, wOther = other?.bindingWindow;
      if (wTarget && wOther && wTarget.hoursLeft !== null && wOther.hoursLeft !== null && wTarget.hoursLeft + 6 < wOther.hoursLeft) {
        if (wTarget.hoursLeft < 2) return `${agentNames[target.provider]}'s usable allowance resets sooner`;
        const day = resetDayName(wTarget.resetsAt, now);
        if (/week|7[- ]?d/i.test(wTarget.label || '')) {
          return `${agentNames[target.provider]} has ${Math.round(wTarget.remaining)}% of its week left and resets ${day}; ${agentNames[other.provider]} is kept for later in the week`;
        }
        return `${agentNames[target.provider]}'s usable allowance resets sooner (${day})`;
      }
      return null;
    };

    if (current && chosen.provider !== current) {
      const before = candidates.find(candidate => candidate.provider === current);
      const allowanceNote = previous ? explainAllowance(chosen, previous) : null;
      if (!before?.eligible || !previous) why.push(`${agentNames[current]} isn’t available under your rules`);
      else if (previous.shortRoom && !previous.shortRoom.resetsSoon) why.push(`${agentNames[current]} has ${Math.round(previous.shortRoom.remaining)}% left and usually spends ~${Math.round(previous.shortRoom.usual)}% on a ${task.tier} run`);
      else if (allowanceNote) why.push(allowanceNote);
      else if (previous.quota.usedPercent >= 80) why.push(`${agentNames[current]} is at ${Math.round(previous.quota.usedPercent)}% of its limit`);
      else if (previous.quota.state !== 'ok') why.push(`${agentNames[current]} has no confirmed allowance`);
      else if (task.tier === 'deep') why.push(`${agentNames[chosen.provider]} has more room for demanding work`);
      else why.push(`${agentNames[chosen.provider]} has more allowance left`);
    } else if (compared) {
      const allowanceNote = explainAllowance(chosen, compared);
      if (allowanceNote) why.push(allowanceNote);
    }


    if (plannedHandoff) {
      why.push(`${agentNames[chosen.provider]} has ${Math.round(chosen.shortRoom.remaining)}% left before its reset (usual ${task.tier} run ~${Math.round(chosen.shortRoom.usual)}%), so a handoff is planned`);
    }

    const choice = {
      provider: chosen.provider,
      model: model ? modelId(model) : null,
      modelName: model ? (model.displayName || model.name || modelId(model)) : null,
      effort,
      tier: task.tier,
      mode,
      reason: why.join(' · '),
      ...(chosen.steppedDown ? { steppedDown: true } : {}),
      ...(plannedHandoff ? { plannedHandoff: true } : {}),
      ...(spendingRemainder ? { remainder: chosen.quota.burndown ? 'expiring' : 'asked' } : {}),
    };
    return { ...choice, ...(assessment ? { assessment: task } : {}), quota: chosen.quota, bindingWindow: chosen.bindingWindow, escalation: escalate(chosen.provider, chosen.models, choice) };
  }

  // Who plans an orchestrated message: the deepest work each mode allows, under the same allowance rules as any message.
  // Cost saving plans with a standard model rather than its lightest, since a weak plan costs more runs than it saves.
  // A planning run is read-only, so tests never retry it.
  function planner(options) {
    const routed = route({ ...options, tier: 'deep' });
    return routed.error ? routed : { ...routed, reason: 'Plans the steps', escalation: null };
  }

  // A plan step (Orchestrate) is routed by the tier it was planned with, which then counts instead of how its text reads.
  const planned = { light: 'a small step, as planned', standard: 'a focused step, as planned', deep: 'a complex step, as planned' };
  const plannedStep = tier => TIERS.includes(tier) ? { tier, reason: planned[tier] } : null;

  // Who plans an orchestrated message: the deepest work each mode allows, under the same allowance rules as any message.
  // A planning run is read-only, so it never escalates and tests never retry it.
  function planner(options) {
    const routed = route({ ...options, assessment: { tier: 'deep', reason: 'plans the steps' } });
    if (routed.error) return routed;
    const { assessment, ...choice } = routed;
    return { ...choice, reason: 'Plans the steps', escalation: null };
  }

  // The same choice when the agent is already decided: a queued prompt that moved at a handoff is routed again for the
  // agent that took over (#93). Null when that agent lists no models, so the caller keeps its own choice.
  function routeTo(provider, rows, { text, attachments = 0, assessment = null, mode = 'smart' }) {
    mode = normalizeMode(mode) || 'smart';
    const task = assessment && TIERS.includes(assessment.tier) ? assessment : classify(text, { attachments }), [tier, wantedEffort] = plan[mode][task.tier];
    let model = pickModel(rows, tier);
    if (!model) return null;
    if (task.tier === 'deep' && modelTier(model) === 'light') return null;
    const choice = { provider, model: modelId(model), modelName: model.displayName || model.name || modelId(model), effort: pickEffort(effortsOf(model), wantedEffort), tier: task.tier, mode, reason: task.reason[0].toUpperCase() + task.reason.slice(1) };
    return { ...choice, escalation: escalate(provider, rows, choice) };
  }

  // Replays a sequence of prompts across modes with recorded usage readings (#128), comparing choices and remaining allowance.
  const DEFAULT_STEP_MOVE = { light: { short: 2, weekly: 0.5 }, standard: { short: 6, weekly: 2 }, deep: { short: 14, weekly: 5 } };
  function replay(prompts, { candidates = [], modes = MODES, current = null, allowApi = false, now = Date.now() } = {}) {
    const results = {};
    for (const rawMode of modes) {
      const mode = normalizeMode(rawMode) || 'smart';
      const state = candidates.map(candidate => ({
        ...candidate,
        usage: candidate.usage ? {
          ...candidate.usage,
          windows: (candidate.usage.windows || []).map(row => ({ ...row })),
        } : candidate.usage,
      }));
      let active = current, previousAssessment = null, previousText = '', assessmentCalls = 0;
      const choices = [];
      for (const entry of prompts) {
        const item = typeof entry === 'string' ? { text: entry } : entry;
        const attachments = item.attachments || 0;
        let assessment = triage(item.text, { attachments, previous: previousAssessment });
        if (!assessment) {
          if (mode === 'saver') {
            const estimate = classify(item.text, { attachments, context: previousText });
            assessment = { tier: estimate.tier, effort: 'low', reason: estimate.reason, source: 'local' };
          } else {
            assessmentCalls++;
            if (item.assessment) {
              assessment = { ...item.assessment, source: 'agent' };
            } else {
              const estimate = classify(item.text, { attachments, context: previousText });
              const tier = estimate.tier === 'light' ? 'standard' : estimate.tier;
              assessment = { tier, effort: tier === 'deep' ? 'high' : 'medium', reason: estimate.reason, source: 'fallback' };
            }
          }
        }
        const choice = route({ text: item.text, attachments, context: previousText, assessment, mode, candidates: state, current: active, allowApi, now });
        choices.push(choice);
        if (!choice.error) {
          const target = state.find(row => row.provider === choice.provider);
          const selectedRow = (target?.models || []).find(row => modelId(row) === choice.model);
          const actualTier = selectedRow ? modelTier(selectedRow) : choice.tier || 'standard';
          const effortBoost = ['max', 'xhigh', 'ultra'].includes(choice.effort) ? 1.25 : choice.effort === 'high' ? 1.1 : choice.effort === 'low' ? 0.8 : 1;
          const defaults = DEFAULT_STEP_MOVE[actualTier] || DEFAULT_STEP_MOVE.standard;
          const customSpend = item.spend?.[choice.provider] ?? item.spend;
          for (const win of target?.usage?.windows || []) {
            if (!windowApplies(win, choice.model) || !Number.isFinite(win.usedPercent)) continue;
            const isWeekly = /week|7[- ]?d/i.test(`${win.label || ''} ${win.id || ''}`);
            const delta = typeof customSpend === 'number' ? customSpend
              : typeof customSpend === 'object' && customSpend !== null ? (customSpend[win.id || win.label] ?? (isWeekly ? customSpend.weekly : customSpend.short) ?? (isWeekly ? defaults.weekly : defaults.short) * effortBoost)
              : (isWeekly ? defaults.weekly : defaults.short) * effortBoost;
            win.usedPercent = Math.min(100, Math.round((win.usedPercent + delta) * 100) / 100);
          }
          active = choice.provider;
          previousAssessment = assessment;
          previousText = item.text;
        }
      }
      const remaining = Object.fromEntries(state.map(row => [
        row.provider,
        Object.fromEntries((row.usage?.windows || []).map(win => [win.label || win.id || 'Plan limit', Math.max(0, Math.round((100 - (win.usedPercent ?? 100)) * 100) / 100)])),
      ]));
      results[mode] = { mode, choices, assessmentCalls, remaining };
    }
    return results;
  }

  root.relayRouting = { MODES, POLICY_VERSION, LEGACY_MODES, normalizeMode, modeNames, handoffThresholds, classify, triage, modelTier, route, routeTo, plannedStep, planner, escalate, assessQuota, adaptiveThreshold, quotaText, remainderText, windowApplies, windowSpendability, bindingWindow, replay };
})(typeof window === 'undefined' ? globalThis : window);
