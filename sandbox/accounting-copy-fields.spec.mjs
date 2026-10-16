/*
 * Browser sandbox: right-click Copy on the Accounting money and Aljex fields.
 *
 * Reported 2026-10-16: "we implemented a right click - delete option on the
 * accounting sheet yesterday and it caused our right click - copy to stop
 * working."
 *
 * This is here rather than only in scripts/ because the bug was invisible to
 * jsdom twice over.
 *
 * - It is about what the BROWSER does with a contextmenu event nobody
 *   cancelled. jsdom has no native context menu, so "the browser's own menu
 *   appears" is unobservable there; only `defaultPrevented` is, and that is
 *   the proxy the unit test has to settle for.
 * - The reason restoring that menu was not enough is a real-browser fact:
 *   a right-click leaves NO selection, so Chrome greys Copy out. That is
 *   measured here, against the shipped page, and it is the measurement the
 *   fix is built on -- if it ever stops being true, the explicit Copy items
 *   are redundant and this spec should say so.
 *
 * It also reads the real clipboard, which is the only check that cannot be
 * satisfied by a menu item that merely looks right.
 *
 * Run: node sandbox/accounting-copy-fields.spec.mjs   (serves itself)
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { boardFixture } from './fixtures.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const server = spawn(process.execPath, ['sandbox/serve.mjs', '.', '8787']);
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
};

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
try {
  // 127.0.0.1 is a secure context, so navigator.clipboard works once granted.
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8787' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  const rows = boardFixture({ shifts: 1, drivers: 1 });
  rows.loads_accounting = [{
    id: 1, location: 'atlanta', shift_date: rows.loads_shifts[0].shift_date,
    aljex_load_number: '2012345', driver_name_text: 'Sandbox Driver',
    total_carrier_pay: 600, total_cost: 600, total_revenue: 900,
    status: 'active', sent: false, hidden: false,
  }];
  rows.loads_accounting_routes = [];
  rows.pricing_settings = [{ key: 'fsc_rate', value: 3 }];
  rows.user_roles = [{ user_id: 'sandbox-user', role: 'admin' }];
  await page.addInitScript((r) => { window.__SANDBOX_ROWS = r; }, rows);

  let fake = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
  fake = fake.replaceAll("email: 'sandbox@dltransport.com'", "email: 'sandbox@dltransport.com', user_metadata: { role: 'admin' }");
  fake = fake.replace('rpc: async () => ({ data: null, error: null }),',
    "rpc: async name=>({data:name==='current_app_role'?'admin':name==='refresh_accounting_daily_rates'?{checked:0,updated:0}:null,error:null}),");
  await page.route('**/supabase.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fake }));

  await page.goto('http://127.0.0.1:8787/accounting.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#acct-1');
  check('the Accounting page loaded with no errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  const closeMenu = () => page.evaluate(() => document.getElementById('acct-context-menu')?.remove());
  const items = () => page.evaluate(() =>
    [...(document.getElementById('acct-context-menu')?.querySelectorAll('.context-menu-item') || [])].map((b) => b.textContent.trim()));

  /*
   * The measurement the whole fix rests on: after a right-click, is anything
   * selected? If not, the browser's Copy is greyed out and restoring its menu
   * could not have fixed the report on its own.
   */
  await page.locator('#acct-1 [data-action="acct-carrier-pay"]').click({ button: 'right' });
  const selectionAfterRightClick = await page.evaluate(() => {
    const el = document.querySelector('#acct-1 [data-action="acct-carrier-pay"]');
    return { input: [el.selectionStart, el.selectionEnd], docChars: String(window.getSelection() || '').length };
  });
  check('a right-click selects nothing, so a native Copy would be greyed out',
    selectionAfterRightClick.input[0] === selectionAfterRightClick.input[1] && selectionAfterRightClick.docChars === 0,
    JSON.stringify(selectionAfterRightClick));

  for (const [action, wanted, value] of [
    ['acct-carrier-pay', 'Copy Rate Carrier 600.00', '600.00'],
    ['acct-customer-rate', 'Copy Rate Customer 900.00', '900.00'],
    ['acct-aljex-number', 'Copy Aljex # 2012345', '2012345'],
  ]) {
    await closeMenu();
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await page.locator(`#acct-1 [data-action="${action}"]`).click({ button: 'right' });
    await page.waitForSelector('#acct-context-menu');
    const list = await items();
    check(`${action}: the menu offers Copy and Delete`,
      list.length === 2 && list[0] === wanted && list[1] === 'Delete from Accounting', JSON.stringify(list));
    await page.locator('#acct-context-menu [data-action="acct-copy-trip-id"]').click();
    await page.waitForTimeout(250);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    // "$600.00" here would mean the cell was read instead of the field.
    check(`${action}: the clipboard holds exactly the field's value`, clip === value, JSON.stringify(clip));
  }

  // Delete has to survive on the same cells.
  await closeMenu();
  await page.locator('#acct-1 [data-action="acct-carrier-pay"]').click({ button: 'right' });
  await page.waitForSelector('#acct-context-menu');
  check('Delete from Accounting is still reachable from a money field',
    await page.locator('#acct-context-menu [data-action="acct-delete"]').count() === 1);
  await closeMenu();

  /*
   * With text highlighted, the browser's menu is the better answer and must
   * not be suppressed. Playwright cannot see the native menu, so what is
   * asserted is the same thing the browser decides on: nothing of ours is in
   * the way, and the event was not cancelled.
   */
  const cancelled = await page.evaluate(() => {
    const el = document.querySelector('#acct-1 [data-action="acct-carrier-pay"]');
    el.focus(); el.setSelectionRange(0, 3);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
    el.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, ourMenu: !!document.getElementById('acct-context-menu') };
  });
  check('a highlighted value keeps the browser menu', cancelled.prevented === false && cancelled.ourMenu === false,
    JSON.stringify(cancelled));

  check('still no page errors after all of it', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
