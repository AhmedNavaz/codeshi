// Provider readings are snapshots, not the outbound text envelope or cumulative token consumption (#85).
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function contextReading(provider, metadata, observedAt) {
  if (metadata.contextUsage) {
    const raw = metadata.contextUsage;
    return { used: count(raw.used), capacity: count(raw.capacity), ...(count(raw.lastRequestInput) !== null ? { lastRequestInput: raw.lastRequestInput } : {}), estimated: raw.estimated === true,
      source: raw.source, windowKind: raw.windowKind || 'model', observedAt, model: raw.model || null,
      ...(count(raw.cacheTtlMs) !== null ? { cacheTtlMs: raw.cacheTtlMs } : {}) };
  }
  const usage = metadata.usage;
  if (!usage) return null;
  if (provider === 'codex' && (usage.last || count(usage.modelContextWindow) !== null)) {
    return { used: null, capacity: count(usage.modelContextWindow), lastRequestInput: count(usage.last?.inputTokens),
      source: 'codex-token-usage', observedAt, note: 'Last request input is not the entire native context.' };
  }
  if (count(usage.used) !== null) return { used: usage.used, capacity: count(usage.size), source: 'acp-usage', observedAt, estimated: false };
  return null;
}

// A single main-agent request, not Claude's cumulative modelUsage or per-turn usage sums.
export function claudeRequestContext(usage) {
  const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  if (!usage || fields.some(key => count(usage[key]) === null)) return null;
  const creation = usage.cache_creation;
  // Prefer the TTL actually reported for this request, including when subscription overage changes it.
  const cacheTtlMs = creation?.ephemeral_5m_input_tokens > 0 ? 300000 : creation?.ephemeral_1h_input_tokens > 0 ? 3600000 : null;
  return { used: null, lastRequestInput: fields.reduce((sum, key) => sum + usage[key], 0),
    source: 'claude-last-request-input', estimated: false, windowKind: 'model', ...(cacheTtlMs ? { cacheTtlMs } : {}) };
}

// Reconstruct the bounded task envelope after a native compaction, while continuing the same native session. This does
// not compact/reset a provider or promise what it retained within the turn that already ran.
export const restoreAfterCompaction = (c, provider, fresh = false) => !fresh &&
  (c.sessions?.[provider]?.needsContextRefresh === true || c.lastRun?.provider === provider && c.lastRun.compactions > 0);
