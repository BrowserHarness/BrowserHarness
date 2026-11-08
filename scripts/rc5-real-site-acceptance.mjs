#!/usr/bin/env node
// Manual release-gate aid: real public internet websites, built RC5 extension,
// isolated Chromium profile and Bridge. Never run this on GitHub Actions.
// Approves only one disposable guest-cart Add to cart, then clears the cart.
// Captured output omits request payloads.
import { startHarness } from './lib/api-engine-harness.mjs';
import { chromium } from 'playwright-core';

const outcomes = [];
const stamp = new Date().toISOString();
const onlyWrite = process.argv.includes('--only-write');
let harness;
const short = (value, n = 280) => String(value || '').slice(0, n);
function mark(id, status, info) {
  outcomes.push({ scenario: id, status, detail: info });
  console.log(`${status} ${id}: ${short(info, 450)}`);
}
const info = (resp) => resp.ok
  ? `verified=${resp.data?.verification?.status || 'n/a'} tier=${resp.data?.answered_by_tier ?? 'n/a'} recipe=${Boolean(resp.data?.recipe_id)}`
  : `error=${resp.error?.code || resp.error?.message || 'unknown'}`;

try {
  harness = await startHarness({
    title: 'RC5 real website acceptance',
    check(name, passed, detail) {
      console.log(`SETUP ${passed ? 'PASS' : 'FAIL'} ${name}: ${short(detail)}`);
      if (!passed) throw new Error(`Setup failed: ${name}: ${short(detail)}`);
    }
  });
  const { command, ctx, extId, side } = harness;
  console.log(`BUILD isolated RC5 extension id ${extId} (${stamp})`);

  if (!onlyWrite) {
  // 1. First see if real-site request learning and execution work end-to-end.
  try {
    const url = 'https://crates.io/search?q={q}';
    const learned = await command('learn-crates', 'site_skill', {
      action: 'learn_api', name: 'public-crate-search', skill_name: 'RC5 crates.io live',
      page_url: url, examples: [{ q: 'serde' }, { q: 'tokio' }],
      verify_args: { q: 'rand' }
    });
    console.log('SCENARIO1 LEARN', info(learned));
    if (!learned.ok) mark('1 public search', 'FAIL', info(learned));
    else {
      const run = await command('run-crates', 'site_skill', {
        action: 'run', id: learned.data?.candidate_id,
        recipe_id: learned.data?.recipe_id, parameters: { q: 'regex' }
      });
      const page = await ctx.newPage();
      await page.goto('https://crates.io/search?q=regex', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.getByText('regex', { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {});
      const visible = (await page.locator('body').innerText()).toLowerCase();
      const output = JSON.stringify(run.data?.run?.output?.data || {}).toLowerCase();
      const pass = learned.data?.verification?.status === 'verified' && run.ok && visible.includes('regex') && output.includes('regex');
      mark('1 public search', pass ? 'PASS' : 'FAIL',
        `learn=${info(learned)}, run=${run.ok ? 'ok' : short(run.error?.code || run.error?.message)}, page_has_regex=${visible.includes('regex')}, result_has_regex=${output.includes('regex')}, tier=${run.data?.run?.output?.api?.tier || 'none'}`);
      await page.close();
    }
  } catch (e) { mark('1 public search', 'BLOCKED', short(e.message)); }

  // 3. Coursera's real search page sends GraphQL #Search POSTs through
  // /graphql-gateway. Prior candidates failed to classify this as a read.
  try {
    const request = {
      action: 'learn_api', name: 'coursera-graphql-search',
      skill_name: 'RC5 Coursera GraphQL live',
      page_url: 'https://www.coursera.org/search?query={q}',
      examples: [{ q: 'python' }, { q: 'javascript' }],
      verify_args: { q: 'machine learning' }
    };
    let learned = await command('coursera-learn', 'site_skill', request);
    const automatic = { ok: learned.ok, verified: learned.data?.verification?.status,
      classification: learned.data?.operation?.side_effect, error: learned.error?.code };
    const autoAcceptable = learned.ok && learned.data?.verification?.status === 'verified' &&
      learned.data?.operation?.side_effect === 'read';
    if (!autoAcceptable) {
      learned = await command('coursera-learn-explicit', 'site_skill', {
        ...request, pick_request: 'POST https://www.coursera.org/graphql-gateway #Search'
      });
    }
    console.log('SCENARIO3 LEARN', info(learned));
    if (!learned.ok) mark('3 GraphQL survives reload', 'FAIL', info(learned));
    else {
      const graphHost = learned.data?.contract?.request?.url || '';
      const graphOperation = learned.data?.operation?.side_effect;
      const live = await ctx.newPage();
      await live.goto('https://www.coursera.org/search?query=cybersecurity', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await live.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
      const ran = await command('coursera-run', 'site_skill', {
        action: 'run', id: learned.data?.candidate_id,
        recipe_id: learned.data?.recipe_id, parameters: { q: 'cybersecurity' }
      });
      const pass = learned.data?.verification?.status === 'verified' &&
        graphHost.includes('/graphql') && graphOperation === 'read' && ran.ok;
      mark('3 GraphQL survives reload', pass ? (autoAcceptable ? 'PASS' : 'PARTIAL') : 'FAIL',
        `${info(learned)} GraphQL_endpoint=${graphHost.includes('/graphql')} classification=${graphOperation} after_reload=${ran.ok ? 'ok' : short(ran.error?.code || ran.error?.message)} automatic=${JSON.stringify(automatic)}`);
      await live.close();
    }
  } catch (e) { mark('3 GraphQL survives reload', 'BLOCKED', short(e.message)); }

  // 4. The live npm search is protected by Cloudflare on this test network.
  // The engine must stop promptly and identify protection or a safe fallback.
  try {
    const start = Date.now();
    const protectedSite = await command('npm-protected', 'site_skill', {
      action: 'learn_api', name: 'npm-search', skill_name: 'RC5 npm protected live',
      page_url: 'https://www.npmjs.com/search?q={q}',
      examples: [{ q: 'react' }, { q: 'vue' }], verify_args: { q: 'svelte' }
    });
    const seconds = Math.round((Date.now() - start) / 1000);
    const code = protectedSite.error?.code || '';
    const tier = protectedSite.data?.answered_by_tier;
    const safe = /BLOCKED|BOT|CHALLENGE|RATE_LIMIT/.test(code) || (protectedSite.ok && tier === 3);
    mark('4 protected site', safe && seconds < 120 ? 'PASS' : 'FAIL',
      `${info(protectedSite)} elapsed=${seconds}s, safe_handling=${safe}`);
  } catch (e) { mark('4 protected site', 'BLOCKED', short(e.message)); }

  // 7. HN Search calls an Algolia sibling host. This tests the website/API
  // association and the ability to run its newly learned cross-host read.
  try {
    const learned = await command('hn-cross-host', 'site_skill', {
      action: 'learn_api', name: 'hn-search', skill_name: 'RC5 HN live',
      page_url: 'https://hn.algolia.com/?q={q}',
      examples: [{ q: 'rust' }, { q: 'python' }], verify_args: { q: 'javascript' }
    });
    const target = learned.data?.contract?.request?.url || learned.data?.operation?.request?.url || '';
    console.log('SCENARIO7 LEARN', info(learned), `api_host=${target ? new URL(target).host : '(unreported)'}`);
    if (!learned.ok) mark('7 cross-host API', 'FAIL', info(learned));
    else {
      const run = await command('hn-cross-host-run', 'site_skill', {
        action: 'run', id: learned.data?.candidate_id,
        recipe_id: learned.data?.recipe_id, parameters: { q: 'linux' }
      });
      const output = JSON.stringify(run.data?.run?.output?.data || {}).toLowerCase();
      const isCrossHost = target.includes('algolia.net');
      const exported = JSON.stringify(learned.data?.contract || {});
      const hasTracker = /google-analytics\.com|telemetry\.algolia\.com|cdn-cgi\/challenge/i.test(exported);
      const headerKeys = Object.keys(learned.data?.contract?.request?.headers || {});
      // The approval string and absence of copied tracking cookies are
      // separate gates; a working search alone does not pass all of scenario 7.
      mark('7 cross-host API', learned.data?.verification?.status === 'verified' && run.ok && isCrossHost ? 'PARTIAL' : 'FAIL',
        `learn=${info(learned)} run=${run.ok ? 'ok' : short(run.error?.code || run.error?.message)} algolia_host=${isCrossHost} output_has_linux=${output.includes('linux')} tracking_host_in_contract=${hasTracker} request_header_keys=${headerKeys.join(',')}; approval-host UI pending`);
    }
  } catch (e) { mark('7 cross-host API', 'BLOCKED', short(e.message)); }

  // 5a. Two genuine user-interface searches recorded on crates.io (Chrome
  // extension Watch Me, not synthetic fixture network requests).
  try {
    const searchDemo = async (q) => {
      const page = await ctx.newPage();
      await page.goto('https://crates.io/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.bringToFront();
      const tabId = await side.evaluate(async (id) => (await chrome.tabs.query({})).find(t => t.id !== id && t.url === 'https://crates.io/')?.id, -1);
      const started = await side.evaluate((id) => chrome.runtime.sendMessage({ type: 'WATCH_START', tab_id: id }), tabId);
      await page.getByRole('textbox', { name: 'Search' }).fill(q);
      await page.getByRole('button', { name: 'Search' }).click();
      await page.waitForURL(new RegExp(`q=${q}`), { timeout: 15000 });
      await page.waitForTimeout(1500);
      const stopped = await side.evaluate(() => chrome.runtime.sendMessage({ type: 'WATCH_STOP' }));
      await page.close();
      return { started, stopped, cap: stopped?.data?.api_capture };
    };
    const first = await searchDemo('serde');
    const second = await searchDemo('tokio');
    console.log('SCENARIO5 CAPTURES', JSON.stringify({
      starts: [first.started?.ok, second.started?.ok],
      requests: [first.cap?.data_requests, second.cap?.data_requests],
      input_names: [first.cap?.inputs, second.cap?.inputs],
      recording_ids: [Boolean(first.cap?.recording_id), Boolean(second.cap?.recording_id)]
    }));
    const learned = await command('watch-live-learn', 'site_skill', {
      action: 'learn_api', skill_name: 'RC5 Watch Me crates live',
      name: 'watched-public-search',
      from_watch: [first.cap?.recording_id, second.cap?.recording_id],
      verify_args: { [first.cap?.inputs?.[0] || 'search']: 'rand' }
    });
    mark('5 Watch Me searches', first.started?.ok && second.started?.ok &&
      learned.ok && learned.data?.verification?.status === 'verified' ? 'PARTIAL' : 'FAIL',
      `captures=${first.cap?.data_requests}/${second.cap?.data_requests}, learn=${info(learned)}; real panel Record UI and write demo still required`);
  } catch (e) { mark('5 Watch Me searches', 'BLOCKED', short(e.message)); }
  }

  // 5b. One harmless guest-cart demonstration on a real Shopify store; learn
  // it as a write, then verify the learned command refuses to send before
  // approval. Clear the guest cart afterwards; no payment or order is made.
  let cartPage;
  try {
    const productUrl = 'https://sabpuja.com/products/akshat-rice';
    const page = await ctx.newPage();
    cartPage = page;
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.bringToFront();
    await page.waitForTimeout(1300);
    const english = page.getByRole('button', {name:/English.*Read.*shop|English/i}).first();
    if (await english.isVisible().catch(()=>false)) await english.click({timeout:10000});
    // The language chooser sometimes appears after initial DOMContentLoaded.
    await page.waitForTimeout(900);
    if (await english.isVisible().catch(()=>false)) await english.click({timeout:10000});
    const cartItems = async () => {
      const response = await page.evaluate(() => fetch('/cart.js').then(r => r.json()));
      return response?.item_count ?? null;
    };
    if ((await cartItems()) > 0) await page.evaluate(() => fetch('/cart/clear.js',{method:'POST'}).then(r=>r.ok));
    const before = await cartItems();
    const tabId = await side.evaluate(async (url) => (await chrome.tabs.query({})).find(t=>t.url?.startsWith(url))?.id, productUrl);
    const started = await side.evaluate(id => chrome.runtime.sendMessage({ type:'WATCH_START',tab_id:id }),tabId);
    try {
      await page.getByRole('button',{name:'Add to cart'}).click({timeout:12000});
    } catch (e) {
      if (await english.isVisible().catch(()=>false)) await english.click({timeout:10000});
      await page.getByRole('button',{name:'Add to cart'}).click({timeout:12000});
    }
    await page.waitForTimeout(1700);
    const stopped = await side.evaluate(() => chrome.runtime.sendMessage({type:'WATCH_STOP'}));
    const after = await cartItems();
    const capture = stopped?.data?.api_capture;
    console.log('SCENARIO5 WRITE DEMO', JSON.stringify({started:started?.ok,recorded:Boolean(capture?.recording_id), data_requests:capture?.data_requests, before, after}));
    // Site-owned test cart reset: intentionally only the disposable browser.
    await page.evaluate(() => fetch('/cart/clear.js',{method:'POST'}).then(r=>r.ok));
    const empty = await cartItems();
    const learn = await command('shopify-watch-write','site_skill', {
      action:'learn_api',name:'add-to-guest-cart',skill_name:'RC5 Sabpuja Watch Me live',
      from_watch:[capture?.recording_id],side_effect:'write',
      pick_request:'POST https://sabpuja.com/cart/add.js'
    });
    console.log('SCENARIO5 WRITE LEARN',info(learn));
    if (!learn.ok) {
      const candidates=(learn.data?.candidates||[]).map(c=>({method:c.method,origin:c.origin,path:c.path}));
      mark('5 Watch Me write approval','FAIL',`${info(learn)}, available_request_paths=${JSON.stringify(candidates)}, demo_added=${after>before}, cleared=${empty===0}`);
    } else {
      const write=learn.data?.operation?.side_effect==='write';
      const attempt = await command('shopify-write-run','site_skill',{
        action:'run',id:learn.data?.candidate_id,
        recipe_id:learn.data?.recipe_id
      });
      const stillEmpty = await cartItems();
      const approval = !attempt.ok && /APPROVAL/.test(attempt.error?.code||'');
      let panelPrompt=false;
      let panelCancelled=false;
      let panelApproved=false;
      let approvedMessage='';
      let panelError='';
      let cdp;
      try {
        const commands=(await command('shopify-list','site_commands')).data?.commands || [];
        // API writes are surfaced as approval-gated form commands.
        const cartCommand=commands.find(c=>c.kind==='form' && c.runs_without_page && /add-to-guest-cart/.test(c.name));
        if (!cartCommand) throw new Error('no named write command');
        await harness.inSidePanel('1');
        cdp=await chromium.connectOverCDP(`http://127.0.0.1:${harness.debugPort}`);
        let panel;
        for (const p of cdp.contexts().flatMap(context=>context.pages())) {
          if (!p.url().endsWith('/sidepanel.html')) continue;
          const inTab=await p.evaluate(()=>new Promise(r=>chrome.tabs.getCurrent(t=>r(Boolean(t)))));
          if (!inTab) { panel=p; break; }
        }
        if (!panel) throw new Error('real side panel not found');
        await panel.reload();
        const box=panel.getByRole('textbox',{name:'Your request'});
        await box.fill(`/${cartCommand.name}`);
        await box.press('Escape').catch(()=>{});
        await panel.getByRole('button',{name:'Send',exact:true}).click();
        await panel.getByText('Is it OK to go ahead?').waitFor({timeout:20000});
        panelPrompt=true;
        await panel.getByRole('button',{name:'Cancel',exact:true}).click();
        panelCancelled=true;
        if ((await cartItems()) !== 0) throw new Error('cart changed after Cancel');
        await box.fill(`/${cartCommand.name}`);
        await box.press('Escape').catch(()=>{});
        await panel.getByRole('button',{name:'Send',exact:true}).click();
        await panel.getByText('Is it OK to go ahead?').waitFor({timeout:20000});
        await panel.getByRole('button',{name:'Approve',exact:true}).click();
        const sent = panel.getByText(/Sent the learned request/).last();
        await sent.waitFor({timeout:25000});
        approvedMessage = await sent.innerText();
        panelApproved = /not confirmed/i.test(approvedMessage);
      } catch(e) {panelError=short(e.message);}
      finally {if(cdp)await cdp.close().catch(()=>{});}
      const afterPanel = await cartItems();
      await page.evaluate(() => fetch('/cart/clear.js',{method:'POST'}).then(r=>r.ok));
      const afterCleanup=await cartItems();
      mark('5 Watch Me write approval', started?.ok && after>before && empty===0 &&
        write && approval && stillEmpty===0 && panelPrompt && panelCancelled && panelApproved && afterPanel===1 && afterCleanup===0 ? 'PASS' : 'FAIL',
        `demonstrated_once=${after>before}, learned_write=${write}, need_approval=${approval}, never_resends=${stillEmpty===0}, panel_prompt=${panelPrompt}, panel_cancelled=${panelCancelled}, panel_approved_sent_unverified=${panelApproved}, cart_after_approve=${afterPanel}, cart_after_cleanup=${afterCleanup}${panelError?`; panel_error=${panelError}`:''}`);
    }
  } catch (e) { mark('5 Watch Me write approval','BLOCKED',short(e.message)); }
  finally {
    if(cartPage) {
      await cartPage.evaluate(() => fetch('/cart/clear.js',{method:'POST'}).then(r=>r.ok)).catch(()=>{});
      await cartPage.close().catch(()=>{});
    }
  }

  if (!onlyWrite) {
  // 8. Launch a second RC5 extension/profile with a separate Bridge. A public
  // test marker cookie and the Skill from profile A must be inaccessible in B.
  // Authenticated session isolation still needs a person to sign in to A.
  let second;
  try {
    const firstLibrary = await side.evaluate(async () => (await chrome.storage.local.get('browserharness.siteSkillLibrary.v2'))['browserharness.siteSkillLibrary.v2']);
    const aFamily = firstLibrary?.families?.[0];
    await ctx.addCookies([{name:'rc5_profile_probe',value:'profile-A-only',url:'https://crates.io'}]);
    second = await startHarness({ title:'RC5 second real browser profile', check(n,ok) { if(!ok)throw new Error('Second profile '+n); } });
    const bPage = await second.ctx.newPage();
    await bPage.goto('https://crates.io/', {waitUntil:'domcontentloaded',timeout:25000});
    const aCookie = (await ctx.cookies('https://crates.io')).some(c=>c.name==='rc5_profile_probe');
    const bCookie = (await second.ctx.cookies('https://crates.io')).some(c=>c.name==='rc5_profile_probe');
    const bLibrary = await second.side.evaluate(async () => (await chrome.storage.local.get('browserharness.siteSkillLibrary.v2'))['browserharness.siteSkillLibrary.v2']);
    const bFamilies = bLibrary?.families?.length || 0;
    const crossAttempt = await second.command('attempt-other-profile','site_skill',{
      action:'run',id:aFamily?.id,recipe_id:aFamily?.revisions?.[0]?.operations?.[0]?.operation_id || 'none',parameters:{q:'serde'}
    });
    mark('8 profile isolation', aCookie&&!bCookie&&Boolean(aFamily)&&bFamilies===0&&!crossAttempt.ok ? 'PARTIAL':'FAIL',
      `two_actual_RC5_profiles=true, first_has_marker=${aCookie}, second_has_marker=${bCookie}, A_has_skill=${Boolean(aFamily)}, B_skill_count=${bFamilies}, B_can_run_A_skill=${crossAttempt.ok}; authenticated-session check pending`);
    await bPage.close();
  } catch(e) { mark('8 profile isolation','BLOCKED',short(e.message)); }
  finally { if(second) await second.close().catch(()=>{}); }

  mark('2 authenticated read', 'BLOCKED',
    'isolated RC5 test profile has no signed-in user account; tier-2 read and sign-out authentication cannot be verified without a live login');
  mark('6 real-site drift repair', 'NOT TRIGGERED',
    'no learned live API drift occurred during this acceptance session');
  }

} catch (e) {
  console.error('ACCEPTANCE HARNESS ERROR', short(e.message, 1000));
} finally {
  if (harness) await harness.close().catch(e => console.error('CLEANUP ERROR', short(e.message)));
  console.log('OUTCOMES', JSON.stringify(outcomes));
}
