import { cdpCommand } from "./cdp-manager";
import { backendNodeForRef } from "./cdp-semantic";

interface BoxModel {
  model?: {
    content?: number[];
    border?: number[];
  };
}

interface LayoutMetrics {
  cssContentSize?: {
    width?: number;
    height?: number;
  };
}

interface ScreenshotResponse {
  data?: string;
}

export interface CdpScreenshotOptions {
  element_id?: string;
  full_page?: boolean;
}

function boundsFromQuad(quad?: number[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (!quad || quad.length < 8) {
    throw new Error("Screenshot target has no usable layout box");
  }

  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;

  if (width <= 0 || height <= 0) {
    throw new Error("Screenshot target has an empty layout box");
  }

  return { x, y, width, height };
}

export async function captureCdpScreenshot(
  tabId: number,
  options: CdpScreenshotOptions = {}
): Promise<{
  data_url: string;
  mode: "viewport" | "full-page" | "element";
}> {
  let clip:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
      }
    | undefined;
  let mode: "viewport" | "full-page" | "element" = "viewport";

  if (typeof options.element_id === "string" && options.element_id) {
    const backendNodeId = await backendNodeForRef(
      tabId,
      options.element_id
    );
    await cdpCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId
    });
    const box = await cdpCommand<BoxModel>(
      tabId,
      "DOM.getBoxModel",
      { backendNodeId }
    );
    clip = {
      ...boundsFromQuad(
        box.model?.content || box.model?.border
      ),
      scale: 1
    };
    mode = "element";
  } else if (options.full_page === true) {
    const metrics = await cdpCommand<LayoutMetrics>(
      tabId,
      "Page.getLayoutMetrics"
    );
    const width = Number(metrics.cssContentSize?.width || 0);
    const height = Number(metrics.cssContentSize?.height || 0);

    if (width <= 0 || height <= 0) {
      throw new Error(
        "Page did not return usable full-page dimensions"
      );
    }

    clip = {
      x: 0,
      y: 0,
      width,
      height,
      scale: 1
    };
    mode = "full-page";
  }

  const screenshot = await cdpCommand<ScreenshotResponse>(
    tabId,
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: mode !== "viewport",
      ...(clip ? { clip } : {})
    }
  );

  if (!screenshot.data) {
    throw new Error("CDP screenshot returned no image data");
  }

  return {
    data_url: `data:image/png;base64,${screenshot.data}`,
    mode
  };
}
