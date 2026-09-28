import { cdpCommand } from "./cdp-manager";
import { backendNodeForRef } from "./cdp-semantic";

interface ResolvedNode {
  object?: {
    objectId?: string;
  };
}

interface RuntimeResult {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
    };
  };
}

export async function selectOptions(
  tabId: number,
  ref: string,
  values: string[]
): Promise<{ selected: string[] }> {
  const requested = [...new Set(values.map((value) => value.trim()))]
    .filter(Boolean);

  if (!requested.length) {
    throw new Error("select_option requires at least one value");
  }

  const backendNodeId = backendNodeForRef(tabId, ref);
  await cdpCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
    backendNodeId
  });
  const resolved = await cdpCommand<ResolvedNode>(
    tabId,
    "DOM.resolveNode",
    { backendNodeId }
  );
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error("Select target could not be resolved");
  }

  const response = await cdpCommand<RuntimeResult>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function(values){if(!(this instanceof HTMLSelectElement))throw new Error('Target is not a select element');const wanted=new Set(values.map(String));const multiple=this.multiple;let matched=0;for(const option of Array.from(this.options)){const hit=wanted.has(String(option.value))||wanted.has(String(option.textContent||'').trim())||wanted.has(String(option.label||'').trim());option.selected=hit&&(multiple||matched===0);if(option.selected)matched+=1;}if(!matched)throw new Error('No requested option matched');this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return Array.from(this.selectedOptions).map((option)=>option.value);}",
      arguments: [{ value: requested }],
      returnByValue: true,
      userGesture: true
    }
  );

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "Select option failed"
    );
  }

  const selected = Array.isArray(response.result?.value)
    ? response.result!.value.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  if (!selected.length) {
    throw new Error("Select option returned no selected values");
  }

  return { selected };
}
