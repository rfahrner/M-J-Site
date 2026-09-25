/*
 * Regression test: driver texts go out from the shared mailbox.
 *
 * Reported by a dispatcher on new Outlook: the mass-text draft comes up under
 * his own dltransport address instead of memppw@dltransport.com, and "Open in
 * Outlook Web" did the same thing.
 *
 * Several people have access to that mailbox and each signs into Outlook as
 * themselves, so a compose window opened the ordinary way composes as the
 * person who clicked. The driver then gets a text from a number nobody
 * recognises and replies land in one dispatcher's personal inbox instead of the
 * shared one everybody watches.
 *
 * Two buttons, and only one of them can be fixed here:
 *
 *  - Open in Outlook Web builds its own URL, so naming the mailbox in the path
 *    makes the draft open inside that mailbox. That is what these checks pin.
 *  - Open in Outlook is a mailto:, which has no sender field at all -- RFC 6068
 *    does not define one. Windows hands the draft to Outlook's default sending
 *    account and nothing in a web page can override it. So the code must not
 *    pretend otherwise, and must say so on screen instead.
 *
 * Run: node scripts/text-send-from-mailbox.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const BOARD = readFileSync(new URL('loadboard.js', root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// The real URL builder, lifted out and run.
const MAILBOX = /const TEXT_FROM_MAILBOX = "([^"]*)";/.exec(BOARD)[1];
const HOST = /const OUTLOOK_WEB_HOST = "([^"]+)";/.exec(BOARD)[1];
const SRC = /function outlookWebComposeUrl\(\)[\s\S]*?\n  \}/.exec(BOARD)[0];
const build = (box) =>
  new Function('TEXT_FROM_MAILBOX', 'OUTLOOK_WEB_HOST', `${SRC}; return outlookWebComposeUrl();`)(box, HOST);

console.log('\n1. the mailbox the texts belong to');
check('it is set', MAILBOX, 'memppw@dltransport.com');

console.log('\n2. the web draft opens inside that mailbox');
// /mail/<address>/ is what tells Outlook on the web to work in that mailbox --
// the same form as /mail/<address>/inbox. Without it the deeplink composes as
// whoever is signed in, and there is no query parameter that changes that.
check('the address is in the path',
  build(MAILBOX), 'https://outlook.office.com/mail/memppw@dltransport.com/deeplink/compose');
// Percent-encoding the @ risks the single-page router treating the segment as
// text and not recognising it as a mailbox; @ is legal in a path as it stands.
check('the @ is left literal', build(MAILBOX).includes('%40'), false);
check('it is still a compose deeplink', build(MAILBOX).endsWith('/deeplink/compose'), true);

console.log('\n3. anything unusable falls back to the old behaviour');
// Someone reaching a driver is better served by a draft from the wrong address
// than by a broken URL.
const PLAIN = 'https://outlook.office.com/mail/deeplink/compose';
check('empty', build(''), PLAIN);
check('whitespace', build('   '), PLAIN);
check('unset', build(undefined), PLAIN);
check('not an address at all', build('memppw'), PLAIN);
// These would end the path segment and send the click somewhere else entirely.
check('a slash cannot break out of the path', build('a/b@c.com'), PLAIN);
check('nor a question mark', build('a?b@c.com'), PLAIN);
check('nor a fragment', build('a#b@c.com'), PLAIN);
check('nor a backslash', build('a\\b@c.com'), PLAIN);

console.log('\n4. the recipients are still built the way the gateway expects');
const OPENER = /function openOutlookWebDraft\(addresses, message\)[\s\S]*?\n  \}/.exec(BOARD)[0];
// digits@textbetter.com needs no escaping and the deeplink wants a plain list.
check('addresses joined unencoded', /to=\$\{addresses\.join\(","\)\}/.test(OPENER), true);
check('the body is still encoded', /body=\$\{encodeURIComponent\(message\)\}/.test(OPENER), true);

console.log('\n5. the mailto is left alone, and admits what it cannot do');
const MAILTO = /function openMailDraft\(addresses, message\)[\s\S]*?\n  \}/.exec(BOARD)[0];
// There is no "from" in a mailto. Inventing one would look like a fix and
// silently do nothing.
for (const bogus of ['from=', 'sender=', 'TEXT_FROM_MAILBOX']) {
  check(`no ${bogus} smuggled into the mailto`, MAILTO.includes(bogus), false);
}

console.log('\n6. the screen says which mailbox to send from');
check('there is a reminder', /function sendFromReminderHtml\(\)/.test(BOARD), true);
const NOTE = /function sendFromReminderHtml\(\)[\s\S]*?\n  \}/.exec(BOARD)[0];
check('it names the mailbox', /\$\{escapeHtml\(box\)\}/.test(NOTE), true);
check('and it is escaped, not interpolated raw', NOTE.includes('${box}'), false);
check('it tells you to change the From for the desktop button', /change the <strong>From<\/strong>/.test(NOTE), true);
check('blank mailbox says nothing at all', /if \(!box\) return "";/.test(NOTE), true);
// Both flows reveal the Outlook buttons in different places, so both need it.
check('the single-send modal shows it', BOARD.includes('id="send-text-send-from"'), true);
check('and clears it when the modal resets', /\$\("#send-text-send-from"\)\?\.remove\(\);/.test(BOARD), true);
// The group modal rebuilds its body on every render, so the note has to be part
// of the template rather than appended to it.
check('the group modal renders it inside the progress body',
  /\$\{s\.outlookOnly \? sendFromReminderHtml\(\) : ""\}/.test(BOARD), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
