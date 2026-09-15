(() => {
  'use strict';

  const normalize = (value) => String(value ?? '')
    .replace(/D&L TRANSPORT/gi, 'CARRIER DOCS')
    .replace(/D&L Transport/gi, 'Carrier Docs')
    .replace(/D&L/gi, 'the office')
    .replace(/M-J App/gi, 'Carrier Docs');

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  window.alert = (message) => nativeAlert(normalize(message));
  window.confirm = (message) => nativeConfirm(normalize(message));

  const scrubNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = normalize(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (!(node instanceof Element)) return;
    for (const child of node.childNodes) scrubNode(child);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scrubNode(node);
      if (record.type === 'characterData') scrubNode(record.target);
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    scrubNode(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, { once: true });
})();
