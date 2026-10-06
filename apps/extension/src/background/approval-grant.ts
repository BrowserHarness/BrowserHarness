export interface ApprovalMessageSender {
  id?: string;
  url?: string;
  tab?: unknown;
}

export interface ToolExecutionOptions {
  approvalGranted?: boolean;
  /** The Space of the task asking; memory and Skills tools answer from it only. */
  spaceId?: string;
}

const RISKY_TRUSTED_ACTION =
  /\b(send|submit|buy|purchase|place order|checkout|delete|remove|confirm|pay|transfer|publish|post|sign out|logout|change password|save changes)\b/i;

export function isRiskyTrustedLabel(label: string): boolean {
  return RISKY_TRUSTED_ACTION.test(label);
}

export function extensionPageApprovalGranted(
  requested: boolean | undefined,
  sender: ApprovalMessageSender,
  extensionId: string,
  extensionBaseUrl: string
): boolean {
  if (requested !== true) return false;
  if (!extensionId || sender.id !== extensionId) return false;
  if (sender.tab) return false;
  if (!sender.url) return false;
  return sender.url.startsWith(extensionBaseUrl);
}
