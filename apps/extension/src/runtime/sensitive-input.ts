// Watch Me never records what a person types into a password, a one-time
// code, or any field of a sign-in or verification step (RC4 acceptance: a
// recording left on by accident captured a sign-in email and its emailed code
// as plain steps). The page decides before a value is read
// (content/sensitive-input.ts, the same code: sharing one module would split
// content.js into chunks it cannot load); this copy is the service worker's
// second line. sensitive-input.test.ts keeps the two identical.

export interface FieldFacts {
  /** the input's type attribute, lower-cased ("text", "email", "password"…) */
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  inputmode?: string;
  max_length?: number;
  /** the field's form (or page) also has a password or one-time-code field */
  beside_secret?: boolean;
  /** the page's address */
  url?: string;
}

const SECRET_AUTOCOMPLETE = /\b(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp)/i;
const SIGN_IN_AUTOCOMPLETE = /\b(username|email|webauthn)\b/i;
const SECRET_WORDS =
  /pass(word|code|phrase)?\b|passwd|\bpwd\b|secret|\botp\b|one.?time|verification|verify|\bauth(entication)?.?code|security.?code|access.?code|login.?code|sign.?in.?code|confirm(ation)?.?code|sms.?code|email.?code|\b2fa\b|\bmfa\b|\btotp\b|\bpin\b|\bcvv\b|\bcvc\b|card.?(number|no)|\btoken\b|\bssn\b/i;
const SIGN_IN_PATH =
  /(^|[/_.-])(login|log-in|log_in|signin|sign-in|sign_in|logon|authenticate|authentication|auth|oauth|sso|verify|verification|otp|2fa|mfa|two-factor|challenge|password|reset-password|forgot)([/_.?#-]|$)/i;
const SIGN_IN_HOST = /^(accounts?|login|auth|signin|sso|id|identity|secure)\./i;

/** A page whose job is signing in or proving who someone is. */
export function isSignInPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return SIGN_IN_HOST.test(parsed.hostname) || SIGN_IN_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Whether Watch Me must not record what is typed into this field: a password,
 * a one-time or verification code, a card secret, or anything typed during a
 * sign-in (the email or username there identifies the account).
 */
export function isSensitiveField(field: FieldFacts): boolean {
  const type = (field.type || "text").toLowerCase();
  if (type === "password") return true;
  const autocomplete = field.autocomplete || "";
  if (SECRET_AUTOCOMPLETE.test(autocomplete)) return true;
  const described = [field.name, field.id, field.label, field.placeholder].filter(Boolean).join(" ");
  if (SECRET_WORDS.test(described)) return true;
  const signIn = field.beside_secret === true || isSignInPage(field.url);
  if (!signIn) return false;
  // in a sign-in step, the account's email or username, and short digit boxes (a code split in boxes)
  if (type === "email" || type === "tel" || SIGN_IN_AUTOCOMPLETE.test(autocomplete) || /e-?mail|user(name)?|login|account|phone/i.test(described)) return true;
  if (field.inputmode === "numeric" || type === "number") return true;
  if (typeof field.max_length === "number" && field.max_length > 0 && field.max_length <= 8) return true;
  // any other text typed on a sign-in page stays out too
  return isSignInPage(field.url);
}

/**
 * The same rule for a typed step that reached the service worker: a second
 * line, should a page's recorder be older than this one.
 */
export function isSensitiveStep(step: {
  action: string;
  url?: string;
  locator?: { input_type?: string; label?: string; accessible_name?: string; attributes?: Record<string, string> };
}): boolean {
  if (step.action !== "type") return false;
  const locator = step.locator || {};
  const attributes = locator.attributes || {};
  return isSensitiveField({
    type: locator.input_type || attributes.type,
    autocomplete: attributes.autocomplete,
    name: attributes.name,
    id: attributes.id,
    label: [locator.label, attributes["aria-label"], locator.accessible_name].filter(Boolean).join(" ") || undefined,
    placeholder: attributes.placeholder,
    url: step.url
  });
}
