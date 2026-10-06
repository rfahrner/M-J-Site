/*
 * Paste this into the browser console on the live load board, then use the
 * board normally. The next time it jumps, run  __whyDidItMove()  and it will
 * print what moved it and the code that asked.
 *
 * It only observes -- it patches nothing permanently and changes no behaviour.
 * Reload the page to remove it.
 */
(() => {
  const log = [];
  const stack = () => new Error().stack.split('\n').slice(3, 7).map(s => s.trim()).join('\n      ');
  const label = (el) => {
    if (el === document.documentElement || el === document.body) return 'the page';
    return (el.tagName || '?') + (el.id ? '#' + el.id : '') +
      (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : '');
  };

  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) {
    log.push({ what: 'scrollIntoView', on: label(this), at: new Date().toISOString().slice(11, 23), stack: stack() });
    return scrollIntoView.apply(this, a);
  };

  const topDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return topDesc.get.call(this); },
    set(v) {
      log.push({ what: 'scrollTop = ' + Math.round(v), on: label(this), at: new Date().toISOString().slice(11, 23), stack: stack() });
      return topDesc.set.call(this, v);
    },
  });

  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (opts) {
    // focus() without preventScroll is allowed to scroll the page to the
    // element -- a classic cause of "it moved on its own".
    if (!opts || opts.preventScroll !== true) {
      log.push({ what: 'focus() without preventScroll', on: label(this), at: new Date().toISOString().slice(11, 23), stack: stack() });
    }
    return focus.call(this, opts);
  };

  ['scrollTo', 'scrollBy'].forEach((m) => {
    const orig = window[m];
    window[m] = function (...a) {
      log.push({ what: 'window.' + m, on: 'the page', at: new Date().toISOString().slice(11, 23), stack: stack() });
      return orig.apply(window, a);
    };
  });

  // Watch the thing that actually scrolls on this board.
  const scroller = document.querySelector('.grid-scroll');
  let last = scroller ? scroller.scrollTop : 0;
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      const now = scroller.scrollTop;
      if (Math.abs(now - last) > 4) {
        log.push({ what: `board scrolled ${Math.round(last)} -> ${Math.round(now)}`, on: '.grid-scroll',
          at: new Date().toISOString().slice(11, 23), stack: '(see the entries just above this one)' });
      }
      last = now;
    }, { passive: true });
  }

  window.__whyDidItMove = (n = 12) => {
    console.log(`%cLast ${Math.min(n, log.length)} things that could move the board:`, 'font-weight:bold');
    log.slice(-n).forEach((e) => console.log(`${e.at}  ${e.what}  on ${e.on}\n      ${e.stack}`));
    return `${log.length} events recorded. Call __whyDidItMove(40) for more.`;
  };
  window.__scrollLog = log;
  console.log('%cScroll tracer armed.', 'color:green;font-weight:bold',
    'Use the board until it jumps, then run:  __whyDidItMove()');
})();
