import { cdpCommand } from "./cdp-manager";

interface RuntimeRemoteObject {
  type?: string;
  value?: unknown;
  description?: string;
}

interface RuntimeEvaluateResponse {
  result?: RuntimeRemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
    };
  };
}

export interface EvaluatePageResult {
  type: string;
  value?: unknown;
  description?: string;
}

export async function evaluatePageExpression(
  tabId: number,
  expression: string,
  maxChars = 50_000
): Promise<EvaluatePageResult> {
  const source = expression.trim();
  if (!source) {
    throw new Error("evaluate requires a non-empty expression");
  }

  const response = await cdpCommand<RuntimeEvaluateResponse>(
    tabId,
    "Runtime.evaluate",
    {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }
  );

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "Page evaluation failed"
    );
  }

  const remote = response.result || {};
  const result: EvaluatePageResult = {
    type: remote.type || typeof remote.value,
    ...(remote.value !== undefined ? { value: remote.value } : {}),
    ...(remote.description ? { description: remote.description } : {})
  };

  const serialized = JSON.stringify(result);
  if (serialized.length > maxChars) {
    throw new Error(
      `Page evaluation result exceeded ${maxChars} characters; narrow the expression`
    );
  }

  return result;
}
