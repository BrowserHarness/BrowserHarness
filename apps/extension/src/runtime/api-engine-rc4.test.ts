// RC4: regressions from the RC3 real-site acceptance (58b154c, sabpuja.com).
// Each test reproduces a defect seen there before its fix.
import { describe, expect, it } from "vitest";
import { apiWriteApprovalMessage, describeWriteTarget, withApiRecipe, type ApiOperationContract } from "./api-recipe";
import { searchContract } from "./api-recipe.fixture";
import { approvalShortcut, askPerson, autoApproves, offersSiteGrant } from "./approval-mode";
import { buildSiteCommands, siteCommandAnswer as commandRecord, type SiteCommand } from "./site-commands";
import type { SiteCandidateSkill, SiteSkillRecipe } from "./site-skill";
import type { SiteSkillFamilyRecord } from "./site-skill-store";
import { siteCommandAnswer } from "../ui/site-command-answer";
import { addGrant } from "../settings/site-grants";
import { tierOrder } from "./api-dispatch";

function addToCart(): ApiOperationContract {
  return {
    ...searchContract(),
    name: "add_to_cart",
    origin: "https://sabpuja.com",
    side_effect: "write",
    side_effect_basis: "POST to an action path (/cart/add)",
    params: [],
    target: {
      kind: "fixed",
      request: "POST https://sabpuja.com/cart/add",
      fields: [{ at: "body form:id", name: "id", value: "44012345678901" }]
    }
  };
}

const grants = addGrant([], "sabpuja.com");
const write = apiWriteApprovalMessage("sabpuja.com", "https://sabpuja.com", addToCart(), "add to cart");

describe("RC3 defect 1: a write asks before every run", () => {
  it("an 'Always allow on this site' grant never answers a write", () => {
    expect(approvalShortcut("risky", write, "sabpuja.com", grants)).toBeNull();
    expect(approvalShortcut("every", write, "sabpuja.com", grants)).toBeNull();
    // the same grant still answers a non-write question on that site
    expect(approvalShortcut("risky", "Trusted click “Search” requires explicit approval.", "sabpuja.com", grants)).toBe("site");
  });

  it("automatic mode never answers a write", () => {
    expect(autoApproves("auto", write)).toBe(false);
    expect(approvalShortcut("auto", write, "sabpuja.com", [])).toBeNull();
  });

  it("a write's question does not offer 'Always allow on this site'", () => {
    expect(offersSiteGrant(write, "sabpuja.com")).toBe(false);
    expect(offersSiteGrant("Trusted click “Search” requires explicit approval.", "sabpuja.com")).toBe(true);
  });

  it("holds when the question is wrapped by a helper or a Site Skill form submit", () => {
    const wrapped = `Helper 1 (add rice to the cart): ${write}`;
    expect(approvalShortcut("auto", wrapped, "sabpuja.com", grants)).toBeNull();
    const submit = "Run Site Skill “sabpuja.com” recipe “Add to cart” and submit on sabpuja.com?";
    expect(approvalShortcut("risky", submit, "sabpuja.com", grants)).toBeNull();
    expect(offersSiteGrant(submit, "sabpuja.com")).toBe(false);
  });
});

describe("RC3 defect 3: a learned write is reported as the request it sent", () => {
  const command: SiteCommand = {
    name: "sabpuja-add-to-cart",
    key: "k",
    title: "sabpuja.com: add to cart",
    site: "sabpuja.com",
    origin: "https://sabpuja.com",
    entry_url: "https://sabpuja.com/products/akshat",
    kind: "form",
    needs_page: false,
    recipe_kind: "api",
    api: { operation_id: "op-1", side_effect: "write", verification: "unverified", min_tier: 1 },
    status: "testing",
    skill_id: "s",
    revision_id: "r",
    recipe_id: "recipe-api-v2-1",
    parameters: [],
    runs: 0,
    worked: 0
  };

  it("never says it filled a form when the learned request was sent", () => {
    // what the service worker returns for an accepted API write
    const record = commandRecord(command, {
      run: { submitted: true, executed_steps: 1, output: { http_status: 200, truncated: false, data: { ok: true }, api: { tier: 2, class: "ok" } } },
      sent: true,
      verification: "unverified",
      next_action: "the site accepted the request; check sabpuja.com to confirm the change, and do not resend it"
    });
    expect(record).toMatchObject({ submitted: true, sent: true, verification: "unverified" });
    const answer = siteCommandAnswer(command, { ok: true, data: record });
    expect(answer).not.toMatch(/fill/i);
    expect(answer).toMatch(/sent/i);
    expect(answer).toMatch(/not (yet )?(confirmed|verified)/i);
    expect(answer).toMatch(/do not resend|don't send it again/i);
    expect(answer).toMatch(/tier 2/);
  });

  it("a write refused before sending says nothing was sent", () => {
    const record = commandRecord(command, { run: { submitted: false, executed_steps: 0 } });
    const answer = siteCommandAnswer(command, { ok: true, data: record });
    expect(answer).not.toMatch(/fill/i);
    expect(answer).toMatch(/nothing was sent|not sent/i);
  });

  it("a UI form command keeps its form wording", () => {
    const form = { ...command, recipe_kind: "ui" as const, needs_page: undefined, api: undefined };
    const record = commandRecord(form, { run: { submitted: true, executed_steps: 3 } });
    expect(siteCommandAnswer(form, { ok: true, data: record })).toMatch(/filled and sent the form/);
  });
});

describe("RC3 defect 3: /site-add-to-cart is the learned request, not the form it was watched on", () => {
  const page = "https://sabpuja.com/products/akshat";
  // Watch Me first saved the product page's form; API learning then added the request to the same Skill
  const watched: SiteCandidateSkill = withApiRecipe(null, {
    contract: { ...searchContract(), origin: "https://sabpuja.com", name: "akshat", params: [] },
    entry_url: page,
    title: "sabpuja.com",
    evidence_id: "ev-watch",
    captured_at: "2026-10-11T14:00:00.000Z"
  });
  const formRecipe: SiteSkillRecipe = {
    id: "recipe-form-1",
    name: "Add to cart",
    entry_url: page,
    form_index: 0,
    method: "POST",
    action: "/cart/add",
    parameters: [],
    steps: [{ kind: "submit", target: { role: "button", accessible_name: "Add to cart", selector_hints: {} } }],
    verification: { required: true, checks: [] }
  } as unknown as SiteSkillRecipe;
  const base = { ...watched, recipes: [formRecipe] };
  const learned = withApiRecipe(base, {
    contract: addToCart(),
    entry_url: page,
    title: "sabpuja.com",
    evidence_id: "ev-learn",
    captured_at: "2026-10-11T14:30:00.000Z"
  });
  const family: SiteSkillFamilyRecord = {
    id: learned.id,
    slug: "sabpuja",
    name: "sabpuja.com",
    latest_revision_id: "rev-2",
    revisions: [{ revision_id: "rev-2", ordinal: 2, created_at: "2026-10-11T14:30:00.000Z", reason: "api", candidate: learned }],
    evaluations: [],
    executions: []
  } as unknown as SiteSkillFamilyRecord;

  it("the plain name runs the learned API operation", () => {
    const commands = buildSiteCommands([family]);
    const plain = commands.find((command) => command.name === "sabpuja-add-to-cart");
    expect(plain?.recipe_kind).toBe("api");
    expect(plain?.needs_page).toBe(false);
    expect(plain?.api?.side_effect).toBe("write");
    // the watched form stays available under its own name
    const form = commands.find((command) => command.recipe_id === "recipe-form-1");
    expect(form?.name).not.toBe("sabpuja-add-to-cart");
    expect(form?.name).toMatch(/form/);
  });
});

describe("RC3 P1: Cancel closes the approval question", () => {
  it("either answer takes the question off the screen and answers once", async () => {
    for (const answer of [false, true]) {
      const shown: Array<{ description: string; resolve: (yes: boolean) => void } | null> = [];
      const pending = askPerson((question) => shown.push(question), "Run add to cart on sabpuja.com?", "sabpuja.com");
      const question = shown.at(-1);
      expect(question?.description).toMatch(/add to cart/);
      question?.resolve(answer);
      question?.resolve(!answer); // a second press changes nothing
      await expect(pending).resolves.toBe(answer);
      expect(shown.at(-1)).toBeNull();
    }
  });
});

describe("RC3 defect 2: the approval names the item a form-data write acts on", () => {
  it("names Akshat (Rice), not 'no item of its own'", () => {
    const contract = addToCart();
    contract.target = {
      kind: "fixed",
      request: "POST https://sabpuja.com/cart/add",
      fields: [{ at: "body multipart:id", name: "id", value: "44012345678901" }],
      label: "Akshat (Rice)"
    };
    expect(describeWriteTarget(contract)).toBe(
      "It always acts on Akshat (Rice) (id 44012345678901) (what it was learned on), not on the page you are viewing."
    );
    const message = apiWriteApprovalMessage("sabpuja.com", "https://sabpuja.com", contract, "add to cart");
    expect(message).toMatch(/Akshat \(Rice\)/);
    expect(message).not.toMatch(/no item of its own/);
  });
});

describe("RC3: an approved write reached a cart nobody sees", () => {
  // the Bridge's plain HTTP has none of the person's session (Shopify's cart
  // cookie): the site answered 200 and added the item to a new, empty cart
  it("a write is sent from the person's browser (tier 2), never plain HTTP", () => {
    const write = { ...addToCart(), min_tier: 1 as const, transport: { preference: [1, 2, 3] as Array<1 | 2 | 3>, learned_tier: 1 as const } };
    expect(tierOrder(write)).not.toContain(1);
    expect(tierOrder(write, 1)).not.toContain(1);
    expect(tierOrder(write)[0]).toBe(2);
    // a read still starts with plain HTTP
    expect(tierOrder({ ...write, side_effect: "read" })[0]).toBe(1);
  });
});
