import { describe, expect, it } from "vitest";
import {
  screenshotVisibilityError,
  shouldActivateNewTaskTab
} from "./tab-policy";

describe("foreground-safe task tab policy", () => {
  it("opens task-created tabs in the background unless explicitly requested", () => {
    expect(shouldActivateNewTaskTab({})).toBe(false);
    expect(shouldActivateNewTaskTab({ active: false })).toBe(false);
    expect(shouldActivateNewTaskTab({ active: true })).toBe(true);
  });

  it("refuses screenshot capture when the target tab is not visible", () => {
    expect(screenshotVisibilityError({ active: false })).toEqual(
      expect.objectContaining({
        code: "SCREENSHOT_REQUIRES_VISIBLE_TAB"
      })
    );
    expect(screenshotVisibilityError({ active: true })).toBeNull();
  });
});
