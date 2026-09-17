// Presentation layer for the Megaboard driver-status strip.
// Keep the source status model untouched; preserve Active -> Upcoming -> Ended
// ordering, remove load/route IDs, and let each colored status chip speak for
// itself without a second redundant group label.

let observer = null;
let scheduled = false;

const GROUPS = [
  { status: 'running' },
  { status: 'upcoming' },
  { status: 'ended' },
];

function groupStrip(strip) {
  if (!strip || strip.dataset.megaGrouped === 'true') return;

  const cards = [...strip.querySelectorAll(':scope > .mega-driver-status-chip')];
  if (!cards.length) return;

  // The load/PRO and trip/route identifiers are useful in the route table below,
  // but they add noise to this at-a-glance driver banner.
  cards.forEach((card) => {
    card.querySelectorAll('.mega-driver-status-id').forEach((node) => node.remove());
  });

  const fragment = document.createDocumentFragment();
  GROUPS.forEach(({ status }) => {
    const matching = cards.filter((card) => card.classList.contains(status));
    if (!matching.length) return;

    const group = document.createElement('div');
    group.className = `mega-driver-status-group ${status}`;

    const items = document.createElement('div');
    items.className = 'mega-driver-status-group-items';
    matching.forEach((card) => items.appendChild(card));
    group.appendChild(items);
    fragment.appendChild(group);
  });

  strip.replaceChildren(fragment);
  strip.dataset.megaGrouped = 'true';
}

function apply() {
  document.querySelectorAll('.mega-driver-status-strip').forEach(groupStrip);
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    apply();
  });
}

function installStyles() {
  if (document.getElementById('mega-driver-status-groups-style')) return;
  const style = document.createElement('style');
  style.id = 'mega-driver-status-groups-style';
  style.textContent = `
    .mega-driver-status-strip {
      align-items: stretch !important;
      gap: 14px !important;
    }
    .mega-driver-status-group {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
      min-width: max-content;
    }
    .mega-driver-status-group + .mega-driver-status-group {
      border-left: 1px solid #d8dee8;
      padding-left: 14px;
    }
    .mega-driver-status-group-items {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .mega-driver-status-id { display:none !important; }
  `;
  document.head.appendChild(style);
}

function init() {
  installStyles();
  const root = document.getElementById('mega-locations');
  if (!root) return;
  apply();
  observer = new MutationObserver(scheduleApply);
  observer.observe(root, { childList: true, subtree: true });
}

window.addEventListener('beforeunload', () => observer?.disconnect());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
