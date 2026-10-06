// Memory v2, Phase 4: older facts and decisions are kept as history, never
// shown as true now, and only brought up for questions about the past.
import { beforeEach, describe, expect, it } from "vitest";
import {
  addFacts,
  factLineage,
  forgetCommand,
  loadAboutMe,
  loadEarlierFacts,
  loadGlobalAboutMe,
  moveFact,
  rememberFacts,
  scopedFactsInMessage,
  updateFact
} from "./about-me";
import {
  currentDecisions,
  decideCommand,
  earlierDecisions,
  parseDecision,
  recordDecision,
  removeDecision,
  reverseDecision
} from "./decisions";
import { createSpace, deleteSpace, DEFAULT_SPACE_ID, pinSpace } from "./spaces";
import { currentState, earlierState, userMemoryPrompt } from "./user-memory";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(keys.map((name) => [name, structuredClone(store[name])]));
          },
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          }
        }
      }
    }
  });
});

async function space(name: string): Promise<string> {
  const created = await createSpace(name, { switchTo: false });
  if (!created.ok) throw new Error("space");
  return created.space.id;
}

const texts = (facts: Array<{ text: string }>) => facts.map((fact) => fact.text);

describe("facts that change", () => {
  it("Pune then Mumbai: Mumbai is true now, Pune is kept as replaced", async () => {
    await rememberFacts(scopedFactsInMessage("I live in Pune"), "learned", DEFAULT_SPACE_ID, "chat-1");
    await rememberFacts(scopedFactsInMessage("I live in Mumbai now"), "learned", DEFAULT_SPACE_ID, "chat-2");
    const [mumbai] = await loadGlobalAboutMe();
    const [pune] = await loadEarlierFacts(undefined, "global");
    expect(texts(await loadGlobalAboutMe())).toEqual(["I live in Mumbai"]);
    expect(pune.text).toBe("I live in Pune");
    expect(pune.status).toBe("superseded");
    expect(pune.superseded_by).toBe(mumbai.id);
    expect(pune.valid_until).toBe(mumbai.created_at);
    expect(mumbai.supersedes).toBe(pune.id);
    expect(mumbai.status).toBe("current");
    // Where it came from, as it actually happened.
    expect(pune.provenance).toMatchObject({ by: "learned", space_id: DEFAULT_SPACE_ID, chat_id: "chat-1" });
    expect(mumbai.provenance).toMatchObject({ by: "learned", space_id: DEFAULT_SPACE_ID, chat_id: "chat-2" });

    const prompt = await userMemoryPrompt(DEFAULT_SPACE_ID, "find a dentist near me");
    expect(prompt).toContain("I live in Mumbai");
    expect(prompt).not.toContain("Pune");
  });

  it("answers “where did I live before Mumbai?” with Pune, labelled as no longer true", async () => {
    await addFacts(["I live in Pune"], "you", undefined, "global");
    await addFacts(["I live in Mumbai"], "you", undefined, "global");
    expect(texts((await earlierState("Where did I live before Mumbai?", DEFAULT_SPACE_ID)).facts)).toEqual(["I live in Pune"]);
    const prompt = await userMemoryPrompt(DEFAULT_SPACE_ID, "Where did I live before Mumbai?");
    expect(prompt).toContain("NO LONGER TRUE");
    expect(prompt.indexOf("I live in Pune")).toBeGreaterThan(prompt.indexOf("NO LONGER TRUE"));
    expect(texts((await currentState(DEFAULT_SPACE_ID)).facts)).toEqual(["I live in Mumbai"]);
    // A past question about something else brings nothing up.
    expect((await earlierState("What did I order last time from Amazon?", DEFAULT_SPACE_ID)).facts).toEqual([]);
  });

  it("“what did I previously say my currency was?” finds the old currency", async () => {
    const w = await space("Work");
    await addFacts(["My currency is USD"], "you", w);
    await addFacts(["My currency is INR"], "you", w);
    expect(texts((await earlierState("What did I previously say my currency was?", w)).facts)).toEqual(["My currency is USD"]);
    expect((await earlierState("What did I previously say my currency was?", DEFAULT_SPACE_ID)).facts).toEqual([]);
  });

  it("English then Hindi for every Space", async () => {
    await rememberFacts(scopedFactsInMessage("My language is English"), "you", DEFAULT_SPACE_ID);
    await rememberFacts(scopedFactsInMessage("My language is Hindi"), "you", DEFAULT_SPACE_ID);
    expect(texts(await loadGlobalAboutMe())).toEqual(["My language is Hindi"]);
    expect(texts(await loadEarlierFacts(undefined, "global"))).toEqual(["My language is English"]);
    const w = await space("Work");
    expect(await userMemoryPrompt(w)).toContain("My language is Hindi");
    expect(await userMemoryPrompt(w)).not.toContain("English");
  });

  it("a Space's own currency wins there without replacing the one for every Space", async () => {
    const w = await space("Work");
    const shop = await space("Shop");
    await addFacts(["My currency is USD"], "you", undefined, "global");
    await addFacts(["My currency is INR"], "you", w);
    expect(await userMemoryPrompt(w)).toContain("My currency is INR");
    expect(await userMemoryPrompt(w)).not.toContain("USD");
    expect(await userMemoryPrompt(shop)).toContain("My currency is USD");
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("My currency is USD");
    const [usd] = await loadGlobalAboutMe();
    expect(usd.status).toBe("current");
    expect(usd.superseded_by).toBeUndefined();
    expect(await loadEarlierFacts(undefined, "global")).toEqual([]);
  });

  it("“In this Space I am based in Delhi” stays this Space's own, even after a new home for every Space", async () => {
    const w = await space("Work");
    await rememberFacts(scopedFactsInMessage("I live in Mumbai"), "you", DEFAULT_SPACE_ID);
    const said = scopedFactsInMessage("In this Space I am based in Delhi");
    expect(said).toEqual([{ text: "I live in Delhi", scope: "space", explicit: true }]);
    await rememberFacts(said, "you", w);
    expect(await userMemoryPrompt(w)).toContain("I live in Delhi");
    expect(await userMemoryPrompt(w)).not.toContain("Mumbai");
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("I live in Mumbai");

    // Moving home for every Space, said in Work or elsewhere, leaves Work's own choice alone.
    await rememberFacts(scopedFactsInMessage("I live in Bangalore"), "learned", w);
    expect(texts(await loadAboutMe(w))).toEqual(["I live in Delhi"]);
    expect(await userMemoryPrompt(w)).toContain("I live in Delhi");
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("I live in Bangalore");
    expect(texts(await loadEarlierFacts(undefined, "global"))).toEqual(["I live in Mumbai"]);
  });

  it("an old home kept in a Space by accident gives way to a new home for every Space, in every Space", async () => {
    const w = await space("Work");
    // Saved before facts for every Space existed: plain, no level chosen.
    store["browserharness.aboutMe"] = [{ id: "old-p", text: "I live in Pune", source: "learned", created_at: "2026-09-01T00:00:00.000Z" }];
    store[`browserharness.aboutMe@${w}`] = [{ id: "old-w", text: "I live in Pune", source: "learned", created_at: "2026-09-02T00:00:00.000Z" }];
    const [mumbai] = await addFacts(["I live in Mumbai"], "learned", DEFAULT_SPACE_ID, "global");
    expect(await loadAboutMe(DEFAULT_SPACE_ID)).toEqual([]);
    expect(await loadAboutMe(w)).toEqual([]);
    for (const id of [DEFAULT_SPACE_ID, w]) {
      const [old] = await loadEarlierFacts(id);
      expect(old).toMatchObject({ text: "I live in Pune", status: "superseded", superseded_by: mumbai.id });
      expect(await userMemoryPrompt(id)).toContain("I live in Mumbai");
      expect(await userMemoryPrompt(id)).not.toContain("Pune");
    }
  });

  it("other topics in other Spaces are left alone by a fact for every Space", async () => {
    const w = await space("Work");
    await addFacts(["My currency is INR"], "you", w);
    await rememberFacts(scopedFactsInMessage("Across all Spaces, my currency is USD"), "you", DEFAULT_SPACE_ID);
    expect(texts(await loadAboutMe(w))).toEqual(["My currency is INR"]);
  });

  it("a fact chosen for this Space on the About you screen is not replaced by one for every Space", async () => {
    const w = await space("Work");
    await addFacts(["I live in Delhi"], "you", w, "space", { explicit: true });
    await addFacts(["I live in Goa"], "you", w, "global");
    expect(texts(await loadAboutMe(w))).toEqual(["I live in Delhi"]);
    const [fact] = await loadGlobalAboutMe();
    pinSpace(w);
    await moveFact(fact.id, "space");
    // Moved here on purpose: replaces Delhi in this Space, and is kept here from now on.
    expect((await loadAboutMe(w))[0]).toMatchObject({ text: "I live in Goa", explicit_scope: true });
    expect(texts(await loadEarlierFacts(w))).toEqual(["I live in Delhi"]);
  });

  it("saying an old fact again makes it true again", async () => {
    await addFacts(["I live in Pune"], "you", undefined, "global");
    await addFacts(["I live in Mumbai"], "you", undefined, "global");
    await addFacts(["I live in Pune"], "you", undefined, "global");
    expect(texts(await loadGlobalAboutMe())).toEqual(["I live in Pune"]);
    expect(texts(await loadEarlierFacts(undefined, "global"))).toEqual(["I live in Mumbai", "I live in Pune"]);
  });

  it("/forget removes old versions too, only in this Space", async () => {
    const w = await space("Work");
    await addFacts(["My budget is 500"], "you", w);
    await addFacts(["My budget is 700"], "you", w);
    await addFacts(["My budget is 900"], "you", DEFAULT_SPACE_ID);
    expect(await forgetCommand("budget", w)).toBe("Forgot 2 facts about “budget”.");
    expect(await loadEarlierFacts(w)).toEqual([]);
    expect(texts(await loadAboutMe(DEFAULT_SPACE_ID))).toEqual(["My budget is 900"]);
  });
});

describe("facts saved before old facts were kept", () => {
  it("load as true now, unchanged, with nothing rewritten", async () => {
    const old = [
      { id: "1", text: "I live in Pune", source: "you", created_at: "2026-10-01T00:00:00.000Z", topic: "home" },
      { id: "2", text: "I prefer window seats", source: "learned", created_at: "2026-10-01T00:00:00.000Z" }
    ];
    store["browserharness.aboutMe"] = structuredClone(old);
    store["browserharness.aboutMe.global"] = [{ id: "3", text: "My name is Neo", source: "you", created_at: "2026-10-02T00:00:00.000Z" }];
    expect(await loadAboutMe(DEFAULT_SPACE_ID)).toEqual(old);
    expect(await loadEarlierFacts(DEFAULT_SPACE_ID)).toEqual([]);
    const prompt = await userMemoryPrompt(DEFAULT_SPACE_ID);
    expect(prompt).toContain("I live in Pune");
    expect(prompt).toContain("My name is Neo");
    expect(store["browserharness.aboutMe"]).toEqual(old);
    // Old facts get no made-up history.
    expect((await loadAboutMe(DEFAULT_SPACE_ID))[0].provenance).toBeUndefined();
  });
});

describe("decisions", () => {
  it("Forgejo then GitHub: GitHub is in force, Forgejo kept and found for questions about the past", async () => {
    const first = await recordDecision({ subject: "Code home", value: "Forgejo", rationale: "self-hosted" }, DEFAULT_SPACE_ID);
    expect(first.ok).toBe(true);
    expect(await decideCommand("code home: GitHub because it's where the team works", DEFAULT_SPACE_ID, "chat-9")).toBe(
      "Noted: Code home is now GitHub. I'll keep “Forgejo” as what you used before."
    );
    const now = await currentDecisions(DEFAULT_SPACE_ID);
    expect(now.map((item) => item.value)).toEqual(["GitHub"]);
    expect(now[0]).toMatchObject({ type: "decision", status: "current", rationale: "it's where the team works", scope: "space" });
    expect(now[0].provenance).toMatchObject({ by: "you", space_id: DEFAULT_SPACE_ID, chat_id: "chat-9" });
    const [old] = await earlierDecisions(DEFAULT_SPACE_ID, "the code home");
    expect(old).toMatchObject({ value: "Forgejo", status: "superseded", superseded_by: now[0].id });
    expect(now[0].supersedes).toBe(old.id);

    const today = await userMemoryPrompt(DEFAULT_SPACE_ID, "push the release");
    expect(today).toContain("Code home: GitHub");
    expect(today).not.toContain("Forgejo");
    const past = await userMemoryPrompt(DEFAULT_SPACE_ID, "What did we use before GitHub for code?");
    expect(past).toContain("EARLIER DECISIONS");
    expect(past).toContain("Code home: Forgejo");
    expect((await earlierState("What decision did we replace?", DEFAULT_SPACE_ID)).decisions.map((item) => item.value)).toEqual(["Forgejo"]);
  });

  it("stay in the Space they were made in", async () => {
    const w = await space("Work");
    const shop = await space("Shop");
    await recordDecision({ subject: "Deployment platform", value: "Vercel" }, w);
    await recordDecision({ subject: "Deployment platform", value: "Netlify" }, w);
    await recordDecision({ subject: "Shop platform", value: "Shopify" }, shop);
    expect((await currentDecisions(w)).map((item) => item.value)).toEqual(["Netlify"]);
    expect((await currentDecisions(shop)).map((item) => item.value)).toEqual(["Shopify"]);
    expect(await currentDecisions(DEFAULT_SPACE_ID)).toEqual([]);
    expect(await earlierDecisions(shop)).toEqual([]);
    expect((await earlierState("What was our previous deployment platform?", shop)).decisions).toEqual([]);
    expect((await earlierState("What was our previous deployment platform?", w)).decisions.map((item) => item.value)).toEqual(["Vercel"]);
    expect(await userMemoryPrompt(shop)).not.toContain("Netlify");
    // Another Space can't take back, or delete, Work's decision.
    const [netlify] = await currentDecisions(w);
    expect(await reverseDecision(netlify.id, shop)).toBe(false);
    expect(await removeDecision(netlify.id, shop)).toBe(false);
    expect(await currentDecisions(w)).toHaveLength(1);
    // Deleting the Space removes its decisions only.
    await deleteSpace(w);
    expect((await currentDecisions(shop)).map((item) => item.value)).toEqual(["Shopify"]);
    expect(await earlierDecisions(w)).toEqual([]);
  });

  it("for every Space only when said, and a Space's own decision wins there", async () => {
    const w = await space("Work");
    expect(parseDecision("everywhere: answer language: English")).toMatchObject({ scope: "global", subject: "answer language", value: "English" });
    expect(await decideCommand("across all Spaces reply language is English", w)).toBe("Noted for every Space: Reply language is English.");
    await recordDecision({ subject: "Reply language", value: "Hindi" }, w);
    expect((await currentDecisions(DEFAULT_SPACE_ID)).map((item) => item.value)).toEqual(["English"]);
    expect((await currentDecisions(w)).map((item) => item.value)).toEqual(["Hindi"]);
    // The one for every Space is not replaced by the Space's own.
    expect(await earlierDecisions(DEFAULT_SPACE_ID)).toEqual([]);
    // And it survives deleting the Space it was made in.
    await deleteSpace(w);
    expect((await currentDecisions(DEFAULT_SPACE_ID)).map((item) => item.value)).toEqual(["English"]);
  });

  it("taking one back keeps it as history; saying the same again changes nothing; secrets are refused", async () => {
    const made = await recordDecision({ subject: "Hosting", value: "Hostinger" }, DEFAULT_SPACE_ID);
    if (!made.ok) throw new Error("decision");
    const again = await recordDecision({ subject: "hosting", value: "hostinger" }, DEFAULT_SPACE_ID);
    expect(again.ok && again.decision.id).toBe(made.decision.id);
    expect(await reverseDecision(made.decision.id, DEFAULT_SPACE_ID)).toBe(true);
    expect(await currentDecisions(DEFAULT_SPACE_ID)).toEqual([]);
    expect((await earlierDecisions(DEFAULT_SPACE_ID))[0].status).toBe("reversed");
    expect((await recordDecision({ subject: "Admin password", value: "hunter22" }, DEFAULT_SPACE_ID)).ok).toBe(false);
    expect(await decideCommand("just a sentence", DEFAULT_SPACE_ID)).toContain("Tell me what you decided");
  });
});

describe("correcting a fact's wording", () => {
  const ids = (facts: Array<{ id: string }>) => facts.map((fact) => fact.id);

  it("keeps the same fact and its topic when the topic still fits", async () => {
    const w = await space("Work");
    pinSpace(w);
    const [inr] = await addFacts(["My currency is INR"], "you", w);
    expect(await updateFact(inr.id, "My currency is USD")).toBe(true);
    const [fixed] = await loadAboutMe(w);
    expect(fixed).toMatchObject({ id: inr.id, text: "My currency is USD", topic: "currency", valid_from: inr.valid_from, created_at: inr.created_at });
    expect(fixed.provenance).toEqual(inr.provenance);
    // A correction, not a change in life: nothing is kept as replaced.
    expect(await loadEarlierFacts(w)).toEqual([]);
  });

  it("follows the new words to a new topic", async () => {
    const w = await space("Work");
    pinSpace(w);
    await addFacts(["My currency is USD"], "you", w);
    const [inr] = await addFacts(["My currency is INR"], "you", w, "space", { explicit: true });
    expect(await updateFact(inr.id, "I live in Mumbai")).toBe(true);
    const fixed = (await loadAboutMe(w)).find((fact) => fact.id === inr.id);
    expect(fixed).toMatchObject({ topic: "home", explicit_scope: true, supersedes: (await loadEarlierFacts(w))[0].id });
    // Still kept as an earlier currency, pointing at the corrected fact.
    expect((await loadEarlierFacts(w))[0]).toMatchObject({ text: "My currency is USD", superseded_by: inr.id });
    // Every-Space currency now shows in Work, and the corrected home wins there.
    await addFacts(["My currency is EUR"], "you", undefined, "global");
    await addFacts(["I live in Pune"], "you", DEFAULT_SPACE_ID, "global");
    const office = await userMemoryPrompt(w);
    expect(office).toContain("My currency is EUR");
    expect(office).toContain("I live in Mumbai");
    expect(office).not.toContain("Pune");
  });

  it("drops a topic the new words no longer have", async () => {
    const w = await space("Work");
    pinSpace(w);
    const [inr] = await addFacts(["My currency is INR"], "you", w);
    await updateFact(inr.id, "I own a bicycle");
    const [fixed] = await loadAboutMe(w);
    expect(fixed.text).toBe("I own a bicycle");
    expect(fixed.topic).toBeUndefined();
    // A later currency no longer replaces the bicycle.
    await addFacts(["My currency is GBP"], "you", w);
    expect(texts(await loadAboutMe(w)).sort()).toEqual(["I own a bicycle", "My currency is GBP"]);
    expect(ids(await loadEarlierFacts(w))).toEqual([]);
  });

  it("a correction onto a topic already in use leaves one current fact on it", async () => {
    const w = await space("Work");
    pinSpace(w);
    const [pune] = await addFacts(["I live in Pune"], "you", w);
    const [bike] = await addFacts(["I own a bicycle"], "you", w);
    await updateFact(bike.id, "I live in Goa");
    expect(texts(await loadAboutMe(w))).toEqual(["I live in Goa"]);
    expect((await loadEarlierFacts(w))[0]).toMatchObject({ id: pune.id, superseded_by: bike.id });
  });
});

describe("moving a fact between this Space and every Space", () => {
  it("moves the same fact, keeping its history linked and its dates", async () => {
    const w = await space("Work");
    pinSpace(w);
    await addFacts(["I live in Pune"], "you", w, "global");
    const [mumbai] = await addFacts(["I live in Mumbai"], "you", w, "global");
    expect(await moveFact(mumbai.id, "space")).toBe(true);
    const [moved] = await loadAboutMe(w);
    // Same record, same dates and provenance: not a new event in life.
    expect(moved).toMatchObject({
      id: mumbai.id,
      text: "I live in Mumbai",
      topic: "home",
      created_at: mumbai.created_at,
      valid_from: mumbai.valid_from,
      supersedes: mumbai.supersedes,
      explicit_scope: true
    });
    expect(moved.provenance).toEqual(mumbai.provenance);
    expect(moved.valid_until).toBeUndefined();
    // Pune still points at it, and the line can be walked both ways.
    const [pune] = await loadEarlierFacts(undefined, "global");
    expect(pune).toMatchObject({ text: "I live in Pune", superseded_by: mumbai.id });
    expect(texts(await factLineage(pune.id, w))).toEqual(["I live in Pune", "I live in Mumbai"]);
    expect(texts(await factLineage(mumbai.id, w))).toEqual(["I live in Pune", "I live in Mumbai"]);
    // No false "moved home" event anywhere.
    expect(await loadEarlierFacts(w)).toEqual([]);
    expect(texts(await loadEarlierFacts(undefined, "global"))).toEqual(["I live in Pune"]);
    // And back to every Space: still the same record, no longer kept here on purpose.
    await moveFact(mumbai.id, "global");
    const [back] = await loadGlobalAboutMe();
    expect(back.id).toBe(mumbai.id);
    expect(back.explicit_scope).toBeUndefined();
    expect(texts(await factLineage(pune.id, w))).toEqual(["I live in Pune", "I live in Mumbai"]);
  });

  it("every Space → this Space, where this Space already has the topic: one current value, the other kept", async () => {
    const w = await space("Work");
    pinSpace(w);
    const [inr] = await addFacts(["My currency is INR"], "you", w);
    const [usd] = await addFacts(["My currency is USD"], "you", undefined, "global");
    await moveFact(usd.id, "space");
    expect(texts(await loadAboutMe(w))).toEqual(["My currency is USD"]);
    const [old] = await loadEarlierFacts(w);
    expect(old).toMatchObject({ id: inr.id, status: "superseded", superseded_by: usd.id });
    expect(old.valid_until! >= usd.created_at).toBe(true);
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect((await loadAboutMe(w))[0].explicit_scope).toBe(true);
  });

  it("this Space → every Space, where every Space already has the topic: one current value, the other kept", async () => {
    const w = await space("Work");
    pinSpace(w);
    const [usd] = await addFacts(["My currency is USD"], "you", undefined, "global");
    const [inr] = await addFacts(["My currency is INR"], "you", w);
    await moveFact(inr.id, "global");
    expect(texts(await loadGlobalAboutMe())).toEqual(["My currency is INR"]);
    expect((await loadGlobalAboutMe())[0]).toMatchObject({ id: inr.id, created_at: inr.created_at, valid_from: inr.valid_from });
    expect((await loadEarlierFacts(undefined, "global"))[0]).toMatchObject({ id: usd.id, superseded_by: inr.id });
    expect(await loadAboutMe(w)).toEqual([]);
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("My currency is INR");
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).not.toContain("USD");
  });

  it("moving onto the very same words leaves one fact and no broken links", async () => {
    const w = await space("Work");
    pinSpace(w);
    await addFacts(["I live in Pune"], "you", w);
    const [local] = await addFacts(["I live in Goa"], "you", w);
    const [shared] = await addFacts(["I live in Goa"], "you", undefined, "global");
    // (The every-Space fact replaced the local one already; say it again here on purpose.)
    const [again] = await addFacts(["I live in Goa"], "you", w, "space", { explicit: true });
    await moveFact(again.id, "global");
    expect(texts(await loadGlobalAboutMe())).toEqual(["I live in Goa"]);
    expect((await loadGlobalAboutMe())[0].id).toBe(shared.id);
    const all = [...(await loadEarlierFacts(w)), ...(await loadEarlierFacts(undefined, "global"))];
    const known = new Set([...all.map((fact) => fact.id), shared.id]);
    for (const fact of all) if (fact.superseded_by) expect(known.has(fact.superseded_by)).toBe(true);
    expect(local.id).not.toBe(shared.id);
  });

  it("is kept to this Space on purpose after moving there, so a new home for every Space leaves it", async () => {
    const w = await space("Work");
    pinSpace(w);
    const [goa] = await addFacts(["I live in Goa"], "you", w, "global");
    await moveFact(goa.id, "space");
    await addFacts(["I live in Delhi"], "learned", DEFAULT_SPACE_ID, "global");
    expect(texts(await loadAboutMe(w))).toEqual(["I live in Goa"]);
    expect(await userMemoryPrompt(w)).toContain("I live in Goa");
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("I live in Delhi");
  });
});
