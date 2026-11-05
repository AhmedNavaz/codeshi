// Run state comes from the main process, so switching workspaces, hiding the
// window or suspending its renderer cannot leave the display policy out of sync.
export function createKeepAwake({ registry, blocker, enabled = false, save = () => {}, onChange = () => {}, pollMs = 5000 }) {
  let preference = enabled === true, id = null, disposed = false, scheduled = false, last = '', state;
  function sync() {
    // Work waiting for a usage limit to reset counts too, so the Mac is awake when the limit resets.
    const runningCount = [...registry.brokers.values()].reduce((count, entry) => count + (entry.broker.running ? 1 : 0) + (entry.broker.backgroundReview ? 1 : 0) + (entry.broker.waitingResumes ? 1 : 0) + (entry.broker.tasks?.running || 0), 0);
    let error = null;
    try {
      if (preference && runningCount && !disposed) {
        if (id === null || !blocker.isStarted(id)) id = blocker.start('prevent-display-sleep');
      } else if (id !== null) { blocker.stop(id); if (!blocker.isStarted(id)) id = null; else throw new Error('The display sleep blocker could not be released.'); }
    } catch (e) { error = e.message || 'The system could not update display sleep prevention.'; }
    let active = false;
    try { active = id !== null && blocker.isStarted(id); } catch (e) { error ||= e.message; }
    state = { enabled: preference, active, runningCount, error };
    const signature = JSON.stringify(state);
    if (signature !== last) { last = signature; onChange({ ...state }); }
    return { ...state };
  }
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    // Broker submission events precede assignment of `broker.running`.
    queueMicrotask(() => { scheduled = false; if (!disposed) sync(); });
  }
  registry.on('update', schedule); registry.on('projects', schedule);
  const timer = pollMs > 0 ? setInterval(sync, pollMs) : null; timer?.unref();
  sync();
  return {
    getState: sync,
    setEnabled(value) {
      if (disposed) throw new Error('The desktop app is stopping.');
      if (typeof value !== 'boolean') throw new Error('Keep awake must be enabled or disabled.');
      save(value); preference = value; return sync();
    },
    dispose() { if (disposed) return; disposed = true; registry.off('update', schedule); registry.off('projects', schedule); if (timer) clearInterval(timer); sync(); },
  };
}
