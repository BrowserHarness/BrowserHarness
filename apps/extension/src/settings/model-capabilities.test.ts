import { describe, expect, it } from "vitest";
import {
  classifyModelCapabilities,
  primaryCapabilityLabel
} from "./model-capabilities";

describe("model capability classification", () => {
  it("classifies chat/instruct agent models", () => {
    const caps = classifyModelCapabilities("nvidia/nemotron-3-super-120b-a12b");
    expect(caps.chat).toBe(true);
    expect(caps.agent).toBe(true);
    expect(primaryCapabilityLabel(caps)).toBe("agent");
  });

  it("classifies embedding models without agent capability", () => {
    const caps = classifyModelCapabilities("nvidia/nv-embed-v2");
    expect(caps.embedding).toBe(true);
    expect(caps.agent).toBe(false);
  });

  it("classifies vision-language models", () => {
    const caps = classifyModelCapabilities("qwen/qwen2.5-vl-72b-instruct");
    expect(caps.vision).toBe(true);
    expect(caps.chat).toBe(true);
    expect(caps.agent).toBe(true);
  });

  it("marks unknown models conservatively", () => {
    const caps = classifyModelCapabilities("vendor/mystery-model");
    expect(caps.unknown).toBe(true);
  });
});
