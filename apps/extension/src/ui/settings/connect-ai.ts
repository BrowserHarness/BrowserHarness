// Test an AI before saving it, and describe the result in plain words.
import {
  createConnection,
  loadRoutingConfig,
  saveConnection,
  saveRoutingConfig,
  type CapabilityHealth,
  type ProviderConfig,
  type ProviderConnection
} from "../../settings/provider-store";
import { classifyModelCapabilities } from "../../settings/model-capabilities";
import { testAgentCapability, testChatCapability, testEmbeddingCapability } from "../../runtime/model-client";

export type TestState = "idle" | "testing" | "success" | "error";

export interface TestOutcome {
  connection: ProviderConnection;
  state: Exclude<TestState, "idle" | "testing">;
  message: string;
}

function healthFromError(error: unknown): CapabilityHealth {
  const message = error instanceof Error ? error.message : String(error);
  let status: CapabilityHealth["status"] = "failed";
  if (/429/.test(message)) status = "rate-limited";
  else if (/401|403|unauthorized/i.test(message)) status = "unauthorized";
  else if (/timed out/i.test(message)) status = "timeout";
  return { status, checkedAt: new Date().toISOString(), message };
}

function healthy(result: { latencyMs: number; preview?: string }): CapabilityHealth {
  return { status: "healthy", latencyMs: result.latencyMs, checkedAt: new Date().toISOString(), message: result.preview };
}

function seconds(ms?: number): string {
  if (!ms && ms !== 0) return "";
  return ms < 1000 ? "in under a second" : `in ${(ms / 1000).toFixed(1)} seconds`;
}

/** Why a check failed, in words a person can act on. */
export function plainProblem(health: CapabilityHealth): string {
  switch (health.status) {
    case "unauthorized":
      return "The service said no. The secret key may be wrong, or your account may need credit.";
    case "rate-limited":
      return "The service is busy or your free limit is used up. Wait a minute and try again.";
    case "timeout":
      return "It took too long to answer. If it runs on this computer, check that the AI app is still running.";
    default:
      return health.message ? `The service answered: ${health.message}` : "It did not answer.";
  }
}

export function isEmbeddingOnly(model: string): boolean {
  const capabilities = classifyModelCapabilities(model);
  return capabilities.embedding && !capabilities.chat && !capabilities.agent && !capabilities.vision;
}

export function testingMessage(model: string): string {
  return isEmbeddingOnly(model)
    ? "Checking that this memory search helper works…"
    : "Checking that this AI can chat and use the browser. This can take up to a minute…";
}

/** Run the checks, save the result, and make it the main AI if there is none yet. */
export async function testAndSave(config: ProviderConfig): Promise<TestOutcome> {
  const embeddingOnly = isEmbeddingOnly(config.model);
  let chatHealth: CapabilityHealth = { status: "unknown" };
  let agentHealth: CapabilityHealth = { status: "unknown" };
  let embeddingHealth: CapabilityHealth = { status: "unknown" };

  if (embeddingOnly) {
    try {
      embeddingHealth = healthy(await testEmbeddingCapability(config));
    } catch (error) {
      embeddingHealth = healthFromError(error);
    }
  } else {
    try {
      chatHealth = healthy(await testChatCapability(config));
    } catch (error) {
      chatHealth = healthFromError(error);
    }
    if (chatHealth.status === "healthy") {
      try {
        agentHealth = healthy(await testAgentCapability(config));
      } catch (error) {
        agentHealth = healthFromError(error);
      }
    } else {
      agentHealth = {
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: "Skipped because it could not chat."
      };
    }
  }

  const connection = createConnection(
    {
      ...config,
      validatedAt: chatHealth.status === "healthy" ? new Date().toISOString() : undefined,
      validatedLatencyMs: chatHealth.latencyMs
    },
    { chatHealth, agentHealth, embeddingHealth }
  );
  if (embeddingOnly) {
    connection.capabilities.embedding = embeddingHealth.status === "healthy";
    connection.capabilities.unknown = false;
  } else if (chatHealth.status === "healthy") {
    connection.capabilities.chat = true;
    connection.capabilities.agent = agentHealth.status === "healthy";
    connection.capabilities.unknown = false;
  }
  await saveConnection(connection);

  const routing = await loadRoutingConfig();
  if (embeddingOnly && embeddingHealth.status === "healthy" && !routing.embeddingConnectionId) {
    await saveRoutingConfig({ ...routing, embeddingConnectionId: connection.id });
  } else if (!embeddingOnly && chatHealth.status === "healthy" && !routing.primaryConnectionId) {
    await saveRoutingConfig({ ...routing, primaryConnectionId: connection.id });
  }

  if (embeddingOnly) {
    return embeddingHealth.status === "healthy"
      ? { connection, state: "success", message: `All set. This helper works (it answered ${seconds(embeddingHealth.latencyMs)}).` }
      : { connection, state: "error", message: `This helper didn't work. ${plainProblem(embeddingHealth)}` };
  }
  if (chatHealth.status !== "healthy") {
    return { connection, state: "error", message: `This AI didn't answer. ${plainProblem(chatHealth)}` };
  }
  return agentHealth.status === "healthy"
    ? {
        connection,
        state: "success",
        message: `All set. This AI can chat with you and use your browser (it answered ${seconds(agentHealth.latencyMs)}).`
      }
    : {
        connection,
        state: "success",
        message: `Saved, but this AI can only chat: it could not show it knows how to use the browser. Try a bigger or newer model for tasks on websites. (${plainProblem(agentHealth)})`
      };
}

/** Make this AI the main one, after a successful check. */
export async function makeMain(connection: ProviderConnection): Promise<void> {
  const current = await loadRoutingConfig();
  await saveRoutingConfig({
    ...current,
    primaryConnectionId: connection.id,
    fallbackConnectionId: current.fallbackConnectionId === connection.id ? undefined : current.fallbackConnectionId
  });
}
