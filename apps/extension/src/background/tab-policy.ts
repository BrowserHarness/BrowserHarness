export function shouldActivateNewTaskTab(
  input: Record<string, unknown>
): boolean {
  return input.active === true;
}

export function screenshotVisibilityError(
  tab: Pick<chrome.tabs.Tab, "active">
): {
  code: "SCREENSHOT_REQUIRES_VISIBLE_TAB";
  message: string;
} | null {
  if (tab.active) return null;

  return {
    code: "SCREENSHOT_REQUIRES_VISIBLE_TAB",
    message:
      "The target task tab is in the background. BrowserHarness will not capture a different foreground tab. Use switch_tab explicitly if visual evidence is necessary."
  };
}
