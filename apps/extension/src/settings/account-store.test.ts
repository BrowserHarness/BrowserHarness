import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountIdFor,
  chooseModel,
  listAccountModels,
  loadAccounts,
  makeAccount,
  removeAccount,
  saveAccount
} from "./account-store";
import { createConnection, loadRoutingConfig, saveConnection } from "./provider-store";
import { filterModels, shortModelName } from "../ui/ModelMenu";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            list.filter((key) => key in store).map((key) => [key, store[key]])
          );
        },
        set: async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        }
      }
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connected services", () => {
  it("keeps one account per service and address", async () => {
    await saveAccount(makeAccount("openrouter", "sk-or-1"));
    await saveAccount(makeAccount("openrouter", "sk-or-2"));
    await saveAccount(makeAccount("lm-studio", "", "http://127.0.0.1:1234/v1/"));
    const accounts = await loadAccounts();
    expect(accounts.map((account) => account.id)).toEqual([
      "lm-studio::http://127.0.0.1:1234/v1",
      "openrouter::https://openrouter.ai/api/v1"
    ]);
    expect(accounts[1].apiKey).toBe("sk-or-2");
  });

  it("treats services behind older saved models as connected", async () => {
    await saveConnection(
      createConnection({ provider: "nvidia", apiKey: "nvapi", model: "meta/llama" })
    );
    const accounts = await loadAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "nvidia", apiKey: "nvapi" });
  });

  it("lists every chat model a service offers, without embeddings", async () => {
    const discover = vi.fn(async () => [
      { id: "qwen/qwen3-8b", capabilities: { chat: true }, primaryCapability: "chat" },
      { id: "deepseek-v4", capabilities: { chat: true }, primaryCapability: "chat" },
      { id: "nomic-embed", capabilities: { embedding: true }, primaryCapability: "embedding" }
    ]);
    const models = await listAccountModels(
      makeAccount("lm-studio", "", "http://127.0.0.1:1234/v1"),
      { discover: discover as never, saved: [] }
    );
    expect(models.map((model) => model.id)).toEqual(["qwen/qwen3-8b", "deepseek-v4"]);
    expect(
      (await listAccountModels(makeAccount("claude-subscription", ""))).map(
        (model) => model.id
      )
    ).toContain("sonnet");
  });

  it("switches the chat to the picked model and keeps earlier checks", async () => {
    const account = makeAccount("lm-studio", "", "http://127.0.0.1:1234/v1");
    const first = await chooseModel(account, "deepseek-v4");
    await saveConnection({ ...first, chatHealth: { status: "healthy" } });
    const second = await chooseModel(account, "qwen/qwen3-8b");
    expect((await loadRoutingConfig()).primaryConnectionId).toBe(second.id);
    const again = await chooseModel(account, "deepseek-v4");
    expect(again.chatHealth.status).toBe("healthy");
    expect((await loadRoutingConfig()).primaryConnectionId).toBe(first.id);
  });

  it("forgets a service and its models together", async () => {
    const account = makeAccount("openrouter", "sk-or");
    await saveAccount(account);
    await chooseModel(account, "qwen/qwen3-235b");
    await removeAccount(accountIdFor("openrouter"));
    expect(await loadAccounts()).toEqual([]);
  });

  it("searches and shortens model names for the menu", () => {
    const models = [
      { id: "anthropic/claude-sonnet-4.5", kind: "chat" },
      { id: "qwen/qwen3-8b", kind: "chat" }
    ];
    expect(filterModels(models, "qwen 8b").map((model) => model.id)).toEqual([
      "qwen/qwen3-8b"
    ]);
    expect(filterModels(models, "")).toHaveLength(2);
    expect(shortModelName("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
  });
});
