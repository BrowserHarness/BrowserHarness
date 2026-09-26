export type ModelCapability =
  | "chat"
  | "agent"
  | "vision"
  | "embedding"
  | "reranker"
  | "audio"
  | "image"
  | "unknown";

export interface ModelCapabilities {
  chat: boolean;
  agent: boolean;
  vision: boolean;
  embedding: boolean;
  reranker: boolean;
  audio: boolean;
  image: boolean;
  unknown: boolean;
}

const EMPTY: ModelCapabilities = {
  chat: false,
  agent: false,
  vision: false,
  embedding: false,
  reranker: false,
  audio: false,
  image: false,
  unknown: false
};

export function classifyModelCapabilities(modelId: string): ModelCapabilities {
  const id = modelId.toLowerCase();
  const capabilities = { ...EMPTY };

  if (/embed|embedding|bge-|e5-|nv-embed|text-embedding/.test(id)) {
    capabilities.embedding = true;
    return capabilities;
  }

  if (/rerank|reranker|nv-rerank/.test(id)) {
    capabilities.reranker = true;
    return capabilities;
  }

  if (/whisper|speech|tts|audio|asr/.test(id)) {
    capabilities.audio = true;
    return capabilities;
  }

  if (/stable-diffusion|flux|image-gen|image-generation/.test(id)) {
    capabilities.image = true;
    return capabilities;
  }

  if (/vision|vlm|vl-|llava|pixtral|qwen2-vl|qwen2.5-vl|nemotron-nano-vl/.test(id)) {
    capabilities.vision = true;
    capabilities.chat = true;
    capabilities.agent = true;
    return capabilities;
  }

  if (
    /instruct|chat|gpt|claude|gemini|llama|mistral|mixtral|qwen|nemotron|deepseek|command-r|phi|gemma/.test(id)
  ) {
    capabilities.chat = true;
    capabilities.agent = true;
    return capabilities;
  }

  capabilities.unknown = true;
  return capabilities;
}

export function primaryCapabilityLabel(capabilities: ModelCapabilities): ModelCapability {
  if (capabilities.embedding) return "embedding";
  if (capabilities.reranker) return "reranker";
  if (capabilities.audio) return "audio";
  if (capabilities.image) return "image";
  if (capabilities.vision) return "vision";
  if (capabilities.agent) return "agent";
  if (capabilities.chat) return "chat";
  return "unknown";
}

export function isAgentCandidate(capabilities: ModelCapabilities): boolean {
  return capabilities.agent || capabilities.unknown;
}
