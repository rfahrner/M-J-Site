// Keep pending manual edits independent of DOM nodes, and flush them before
// Accounting Refresh checks calculated rates or replaces the table contents.
export function createAccountingMoneyQueue(save, delay) {
  const pending = new Map();
  const running = new Map();
  const latest = new Map();
  function start(key, job) {
    if (pending.get(key) === job) pending.delete(key);
    clearTimeout(job.timer);
    // Serialize both money columns for a load: Market revenue depends on
    // carrier pay, so clearing both must use the newly recalculated carrier.
    const rowKey = String(job.args[0].id);
    const previous = running.get(rowKey) || Promise.resolve();
    const promise = previous.catch(() => {}).then(() => save(...job.args, () => latest.get(key) === job)).then(ok => {
      if (ok === false) throw new Error('A manual Accounting rate could not be saved.');
    });
    running.set(rowKey, promise);
    void promise.finally(() => {
      if (running.get(rowKey) === promise) running.delete(rowKey);
      if (latest.get(key) === job) latest.delete(key);
    }).catch(() => {});
    return promise;
  }
  return {
    schedule(rec, field, value) {
      const key = `${rec.id}:${field.column}`;
      clearTimeout(pending.get(key)?.timer);
      const job = { args: [rec, field, value], timer: null };
      pending.delete(key); // flushing follows the latest edit order across columns
      pending.set(key, job);
      latest.set(key, job);
      job.timer = setTimeout(() => { void start(key, job).catch(() => {}); }, delay);
    },
    overlay(record) {
      const merged = { ...record };
      for (const job of latest.values()) {
        const [rec, field, value] = job.args;
        if (String(rec.id) !== String(record.id)) continue;
        merged[field.column] = value;
        if (field.freezes) merged[field.freezes] = value !== null;
      }
      return merged;
    },
    async flush() {
      const writes = [...running.values()];
      for (const [key, job] of pending) writes.push(start(key, job));
      await Promise.all(writes);
    },
  };
}
