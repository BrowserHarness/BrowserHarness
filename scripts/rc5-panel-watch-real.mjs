#!/usr/bin/env node
// Manual RC5 release gate: two real crates.io searches recorded with the real
// Chrome side panel, in an isolated profile. No account, order or purchase.
import { chromium } from 'playwright-core';
import { startHarness } from './lib/api-engine-harness.mjs';

const checks = [];
const check = (name, ok, note = '') => {
  checks.push({ name, passed: Boolean(ok), note: String(note).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `: ${String(note).slice(0, 220)}` : ''}`);
};
const until = async (predicate, ms = 10000) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    if (await predicate().catch(() => false)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
};
let harness;
let cdp;
try {
  harness = await startHarness({ title: 'RC5 live sidepanel Watch Me', check });
  const { side, ctx, command, debugPort } = harness;
  await harness.inSidePanel('1');
  cdp = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  let panel;
  for (const page of cdp.contexts().flatMap(context => context.pages())) {
    if (!page.url().endsWith('/sidepanel.html')) continue;
    const isTab = await page.evaluate(() => new Promise(resolve => chrome.tabs.getCurrent(tab => resolve(Boolean(tab)))));
    if (!isTab) panel = page;
  }
  if (!panel) throw new Error('real sidepanel unavailable');
  const status = async () => (await side.evaluate(() => chrome.runtime.sendMessage({type:'WATCH_STATUS'})))?.data || {};
  const badge = () => side.evaluate(() => chrome.action.getBadgeText({}));
  const captures = [];
  for (const q of ['serde', 'tokio']) {
    const page = await ctx.newPage();
    try {
      const beforeText = await panel.locator('body').innerText();
      const previousSaved = (beforeText.match(/Saved “Workflow/g) || []).length;
      await page.goto('https://crates.io/', {waitUntil:'domcontentloaded',timeout:25000});
      await page.bringToFront();
      const tabId = await side.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
      check(`${q}: website tab selected`, Boolean(tabId));
      const start = panel.getByRole('button', { name:'Record workflow' });
      await start.click({timeout:10000});
      const recording = await until(async () => (await status()).recording === true, 9000);
      const before = await status();
      check(`${q}: panel records the tab in front`, recording && before.root_tab_id === tabId, `active_tab_matches=${before.root_tab_id === tabId}`);
      check(`${q}: recording is visible in page, badge and panel`, await until(async () =>
        (await badge()) === 'REC' &&
        (await page.locator('#browserharness-recording-banner').count()) === 1 &&
        (await panel.getByRole('status',{name:'Recording in progress'}).isVisible()), 6000));
      await page.getByRole('textbox', {name:'Search'}).fill(q);
      await page.getByRole('button', {name:'Search'}).click();
      await page.waitForURL(new RegExp(`q=${q}`), {timeout:18000});
      await page.waitForTimeout(1500);
      const id = before.recording_id;
      await panel.getByRole('button',{name:'Finish recording'}).first().click({timeout:10000});
      const finished = await until(async () => !(await status()).recording, 10000);
      const saved = await until(async () => ((await panel.locator('body').innerText()).match(/Saved “Workflow/g) || []).length > previousSaved, 12000);
      const ended = (await badge()) === '' && (await page.locator('#browserharness-recording-banner').count()) === 0;
      check(`${q}: Finish saves workflow and clears indicators`, finished && saved && ended);
      const response = await panel.locator('body').innerText();
      console.log('RECORDING NOTE', q, JSON.stringify({
        contains_api_capture: response.includes('data requests'),
        api_captures: [...response.matchAll(/It also made (\d+) data requests:.*?recording ([0-9a-f-]+)/g)].map((match) => ({count:Number(match[1]),id_suffix:match[2].slice(-6)})),
        saved_count: (response.match(/Saved “Workflow/g) || []).length,
        tail: response.slice(-350),
        id_suffix: String(id || '').slice(-6)
      }));
      if (q === 'serde') {
        const immediate = await command('check-single-capture', 'site_skill', {
          action: 'learn_api',name:'search-probe',skill_name:'RC5 real panel probe',
          from_watch:[id],verify_args:{search:'rand'}
        });
        console.log('FIRST CAPTURE PROBE', JSON.stringify({ ok:immediate.ok,
          code:immediate.error?.code,verified:immediate.data?.verification?.status }));
      }
      captures.push(id);
    } finally {
      if ((await status()).recording) await side.evaluate(() => chrome.runtime.sendMessage({type:'WATCH_STOP'}));
      await page.close();
    }
  }
  const learned = await command('panel-search-learn', 'site_skill', {
    action:'learn_api', name:'search', skill_name:'RC5 real sidepanel crates.io',
    from_watch:captures, verify_args:{search:'rand'}
  });
  check('real-panel Watch Me learns two searches and verifies',
    Boolean(learned.ok && learned.data?.verification?.status === 'verified'),
    `recordings=${captures.length} status=${learned.data?.verification?.status || learned.error?.code || 'unknown'}`);
  if (!learned.ok) {
    console.log('LEARN FAILURE', JSON.stringify({code:learned.error?.code, message:learned.error?.message?.slice(0,280),
      candidates:(learned.data?.candidates || []).map(item => ({method:item.method,path:item.path}))}));
  }
} catch (error) {
  check('real-panel Watch Me completed', false, error.message);
} finally {
  if (cdp) await cdp.close().catch(()=>{});
  if (harness) await harness.close().catch(()=>{});
  console.log('RESULTS', JSON.stringify(checks));
  process.exitCode = checks.every(c=>c.passed) ? 0 : 1;
}
