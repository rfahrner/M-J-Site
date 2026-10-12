// Keep pending manual edits independent of DOM nodes, and flush them before
// Accounting Refresh checks calculated rates or replaces the table contents.
export function createAccountingMoneyQueue(save, delay) {
  const pending = new Map();
  const running = new Map();
  function start(key, job) {
    if (pending.get(key) === job) pending.delete(key);
    clearTimeout(job.timer);
    const previous = running.get(key) || Promise.resolve();
    const promise = previous.catch(() => {}).then(() => save(...job.args)).then(ok => {
      if (ok === false) throw new Error('A manual Accounting rate could not be saved.');
    });
    running.set(key, promise);
    void promise.finally(() => {
      if (running.get(key) === promise) running.delete(key);
    }).catch(() => {});
    return promise;
  }
  return {
    schedule(rec, field, value) {
      const key = `${rec.id}:${field.column}`;
      clearTimeout(pending.get(key)?.timer);
      const job = { args: [rec, field, value], timer: null };
      pending.set(key, job);
      job.timer = setTimeout(() => { void start(key, job).catch(() => {}); }, delay);
    },
    async flush() {
      const writes = [...running.values()];
      for (const [key, job] of pending) writes.push(start(key, job));
      await Promise.all(writes);
    },
  };
}
