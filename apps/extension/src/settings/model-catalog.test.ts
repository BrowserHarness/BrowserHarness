import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "./model-catalog";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverModels", () => {
  it("loads and sorts OpenAI-compatible model ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "z/model" },
            { id: "a/model" },
            { id: "a/model" }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const models = await discoverModels({
      provider: "nvidia",
      apiKey: "nvapi-test",
      baseUrl: "https://integrate.api.nvidia.com/v1"
    });

    expect(models.map((model) => model.id)).toEqual(["a/model", "z/model"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer nvapi-test"
        })
      })
    );
  });

  it("surfaces provider errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );

    await expect(
      discoverModels({
        provider: "nvidia",
        apiKey: "bad-key",
        baseUrl: "https://integrate.api.nvidia.com/v1"
      })
    ).rejects.toThrow("Could not load models (401)");
  });
});
