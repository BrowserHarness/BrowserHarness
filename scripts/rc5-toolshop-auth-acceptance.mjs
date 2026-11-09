#!/usr/bin/env node
// Public third-party acceptance: Toolshop's documented QA-only accounts.
// Supply RC5_TOOLSHOP_EMAIL_A, RC5_TOOLSHOP_EMAIL_B and RC5_TOOLSHOP_PASSWORD
// via the environment. No passwords, tokens or cookies are printed or saved.
// Never run this against personal accounts or as part of CI.
import { startHarness } from "./lib/api-engine-harness.mjs";

const origin = "https://practicesoftwaretesting.com";
const api = "https://api.practicesoftwaretesting.com";
const results = [];
const check = (name, passed, detail = "") => {
  results.push({ name, status: passed ? "PASS" : "FAIL" });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const setup = (name, passed, detail = "") => {
  check(`setup: ${name}`, passed, passed ? "" : String(detail).slice(0, 200));
  if (!passed) throw new Error(`Setup failed: ${name}`);
};
const { RC5_TOOLSHOP_EMAIL_A: emailA, RC5_TOOLSHOP_EMAIL_B: emailB, RC5_TOOLSHOP_PASSWORD: password } = process.env;
if (!emailA || !emailB || !password || emailA === emailB) {
  console.error("Provide two distinct published Toolshop demo customer emails and their demo password in environment variables.");
  process.exit(2);
}

let first, second;
const signIn = async (harness, email) => {
  const page = await harness.ctx.newPage();
  await page.goto(`${origin}/auth/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("[data-test=email]").fill(email);
  await page.locator("[data-test=password]").fill(password);
  const accountCall = page.waitForResponse((r) => r.url().startsWith(`${api}/users/me`) && r.status() === 200, { timeout: 25000 });
  await page.locator("[data-test=login-submit]").click();
  await accountCall;
  await page.waitForURL(`${origin}/account`, { timeout: 15000 });
  return page;
};
try {
  first = await startHarness({ check: setup, title: "RC5 public Toolshop profile A", setupFixtureSession: false });
  const aPage = await signIn(first, emailA);
  check("A signs in through the third-party demo website", aPage.url() === `${origin}/account`);

  const learned = await first.command("toolshop-public-auth-learn", "site_skill", {
    action: "learn_api", name: "my_account", skill_name: "Toolshop public demo account",
    page_url: `${origin}/account`, examples: [{}], pick_request: `GET ${api}/users/me`
  });
  check("real cross-host authenticated account API is verified", learned.ok && learned.data?.verification?.status === "verified",
    learned.ok ? `tier=${learned.data.answered_by_tier ?? "unknown"}` : `error=${learned.error?.code ?? "unknown"}`);

  let read;
  if (learned.ok) {
    read = await first.command("toolshop-public-auth-run", "site_skill", {
      action: "run", id: learned.data.candidate_id, recipe_id: learned.data.recipe_id, parameters: {}
    });
    const payload = JSON.stringify(read.data?.run?.output?.data || {});
    check("learned live account read returns A only", read.ok && payload.includes(emailA) && !payload.includes(emailB),
      read.ok ? `tier=${read.data?.run?.answered_by_tier ?? "unknown"}` : `error=${read.error?.code ?? "unknown"}`);
  }

  const tokens = await aPage.evaluate(() => Object.entries(localStorage)
    .filter(([key, value]) => /token|jwt|auth/i.test(key) && value.length > 30)
    .map(([, value]) => value));
  const aStorage = JSON.stringify(await first.side.evaluate(async () => chrome.storage.local.get(null)));
  check("live password and authentication tokens absent from extension storage", !aStorage.includes(password)
    && tokens.every((token) => !aStorage.includes(token)));

  second = await startHarness({ check: setup, title: "RC5 public Toolshop profile B", setupFixtureSession: false });
  const bGuest = await second.ctx.newPage();
  const guestStatuses = [];
  bGuest.on("response", (response) => {
    if (response.url().startsWith(`${api}/users/me`)) guestStatuses.push(response.status());
  });
  await bGuest.goto(`${origin}/account`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await bGuest.waitForTimeout(1500);
  check("independent B profile has no A login session", guestStatuses.includes(401) && !guestStatuses.includes(200));
  const bStorage = JSON.stringify(await second.side.evaluate(async () => chrome.storage.local.get("browserharness.siteSkillLibrary.v2")));
  check("independent B profile has no A learned operation", !learned.ok || !bStorage.includes(learned.data.candidate_id));
  if (learned.ok) {
    const bAttempt = await second.command("toolshop-public-cross-profile", "site_skill", {
      action: "run", id: learned.data.candidate_id, recipe_id: learned.data.recipe_id, parameters: {}
    });
    check("B cannot execute A's private learned account Skill", !bAttempt.ok);
  }
  await bGuest.close();
  const bPage = await signIn(second, emailB);
  check("B signs into a different live demo customer account", bPage.url() === `${origin}/account`);
  const aName = (await aPage.locator("body").innerText()).slice(0,650);
  const bName = (await bPage.locator("body").innerText()).slice(0,650);
  check("A and B show different authenticated people", aName.includes("Jane Doe") && bName.includes("Jack Howe"));

  // Only a website UI logout is admissible; removing a token in the test is not.
  const accountNav = aPage.getByText("Jane Doe", { exact: true }).first();
  await accountNav.click();
  const logout = aPage.getByText(/sign out|logout|log out/i).first();
  await logout.click();
  await aPage.waitForTimeout(1400);
  check("A signs out using the live site's UI", !aPage.url().endsWith("/account"));
  if (learned.ok) {
    const signedOut = await first.command("toolshop-public-signed-out", "site_skill", {
      action: "run", id: learned.data.candidate_id, recipe_id: learned.data.recipe_id, parameters: {}
    });
    check("learned account read fails after actual sign-out without stale A data", !signedOut.ok
      && signedOut.error?.code === "API_AUTH" && !JSON.stringify(signedOut).includes(emailA),
      signedOut.ok ? "unexpected success" : `error=${signedOut.error?.code ?? "unknown"}`);
  }
  await bPage.reload({ waitUntil: "domcontentloaded" });
  await bPage.waitForTimeout(1100);
  check("A logging out leaves B signed in", bPage.url().endsWith("/account"));
} catch (error) {
  check("public Toolshop acceptance completed without exception", false, String(error?.message || error).slice(0,350));
} finally {
  await second?.close().catch(() => undefined);
  await first?.close().catch(() => undefined);
}

const passed = results.filter((r) => r.status === "PASS").length;
console.log(`TOOLSHOP_AUTH ${JSON.stringify({ passed, total: results.length, cases: results })}`);
process.exit(passed === results.length ? 0 : 1);
