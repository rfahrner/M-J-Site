// Keep the selected board day through deploy reloads and idle/resume reloads.
const BOARD_PAGES = new Set(['index.html', 'dalaware.html', 'buildingc.html', 'houston.html', 'mondelez.html']);
function boardKey() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  return BOARD_PAGES.has(page) ? `mj-board-date:${page}` : null;
}
export function restoreBoardDate(fallback, min, max) {
  try {
    const key = boardKey();
    const saved = key && sessionStorage.getItem(key);
    if (!saved || !/^\d{4}-\d{2}-\d{2}$/.test(saved) || saved < min || saved > max) return fallback;
    const date = new Date(saved + 'T12:00:00Z');
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== saved) return fallback;
    return saved;
  } catch { return fallback; }
}
export function installBoardDatePersistence(getDate) {
  window.addEventListener('pagehide', () => {
    try {
      const key = boardKey();
      if (key) sessionStorage.setItem(key, getDate());
    } catch { /* Browsing still works when storage is blocked. */ }
  });
}
