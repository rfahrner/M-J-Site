// Shared presentation state only. No loadboard imports or module-time DOM reads.
// The alert scanners own eligibility; collapsing never changes these sources.
export function createAlertWidgetState() {
  const sources = new Map(), unread = new Set();
  let expanded = false, closed = false;
  const id = (source, key) => JSON.stringify([source, key]);
  return {
    setSource(source, keys) {
      const previous = sources.get(source) || new Set();
      const next = new Set(keys.map(String));
      for (const key of previous) if (!next.has(key)) unread.delete(id(source, key));
      for (const key of next) if (!previous.has(key) && (!expanded || closed)) unread.add(id(source, key));
      sources.set(source, next);
    },
    setView(view) {
      if ('expanded' in view) expanded = !!view.expanded;
      if ('closed' in view) closed = !!view.closed;
      if (expanded && !closed) unread.clear();
    },
    snapshot() {
      const count = [...sources.values()].reduce((sum, keys) => sum + keys.size, 0);
      return {count, unread:unread.size, expanded, closed, notify:unread.size > 0 && (!expanded || closed)};
    },
  };
}
const widgetState = createAlertWidgetState();
export function setAlertWidgetSource(source, keys) {
  widgetState.setSource(source, keys);
  renderAlertWidgetIndicator();
}
export function setAlertWidgetView(view) {
  widgetState.setView(view);
  renderAlertWidgetIndicator();
}
export function renderAlertWidgetIndicator(root = document) {
  const value = widgetState.snapshot();
  const setText = (id, text) => {
    const el = root.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  };
  setText('alert-widget-count', value.count ? `(${value.count})` : '');
  setText('alert-widget-new', value.notify ? `${value.unread} new` : '');
  setText('alert-widget-reopen-count', value.count ? String(value.count) : '');
  const label = `${value.count} active alert${value.count === 1 ? '' : 's'}${value.unread ? `, ${value.unread} new` : ''}`;
  const widget = root.getElementById('alert-widget');
  widget?.classList.toggle('blinking', value.notify);
  const reopen = root.getElementById('alert-widget-reopen');
  reopen?.classList.toggle('blinking', value.notify);
  if (reopen) {
    reopen.title = `Show alerts — ${label}`;
    reopen.setAttribute('aria-label', `Show alerts — ${label}`);
  }
  const minimize = root.getElementById('alert-widget-minimize');
  if (minimize) {
    minimize.title = value.expanded ? 'Minimize alerts' : 'Expand alerts';
    minimize.setAttribute('aria-expanded', String(value.expanded));
  }
}
