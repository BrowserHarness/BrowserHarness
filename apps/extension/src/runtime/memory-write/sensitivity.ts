// The one check for whether something is safe to keep in memory. Every
// durable memory writer uses it (facts, preferences, standing instructions,
// decisions), and Skills use its field-name check to keep typed secrets out.
//
// It blocks secrets written out, not talk about them: "my password is
// hunter2" is refused, "never type my password without asking" is a fine
// instruction. Plain numbers (order numbers, product IDs, prices) pass.

export type SensitiveReason =
  | "password"
  | "PIN"
  | "verification code"
  | "recovery code"
  | "API key or access token"
  | "session cookie"
  | "private key"
  | "secret phrase"
  | "payment card number"
  | "ID or account number";

export type SafetyCheck = { allowed: true } | { allowed: false; reason: SensitiveReason };

/** "is", ":", "=" or "-" between a name and a value, as in "my password is …". */
const IS = String.raw`\s*(?:is|was|=|:|-)\s*`;
/**
 * A value written straight after the name, with no "is" or colon ("password
 * hunter2", "OTP 482913"). It must look like a secret (a digit or a symbol in
 * it), so "never type my password without asking" stays a fine instruction.
 */
const SECRETISH = String.raw`(?=[^\s]*[\d!@#$%^&*_+=~])[^\s]{4,}`;
/** Name then value, with or without "is" or a colon in between. */
const named = (names: string, value: string, bareValue = SECRETISH) =>
  new RegExp(String.raw`\b(?:${names})(?:${IS}${value}|\s+${bareValue})`, "i");
/** Value first: "hunter2 is my password", "1234 is my PIN". */
const reversed = (value: string, names: string) =>
  new RegExp(String.raw`(?:^|\s)${value}\s+(?:is|was)\s+(?:my|our|the|his|her|their)\s+(?:${names})\b`, "i");

const PASSWORD = "password|passcode|passwd|passphrase|pwd";
const PIN = String.raw`(?:atm |upi |card |debit card |credit card )?pin(?! ?code)`;
const CODE = String.raw`otp|one[- ]time (?:pass(?:word|code)|code)|verification code|security code|2fa code|login code|auth(?:entication)? code`;
const KEY_NAMES = String.raw`api[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|bearer[ _-]?token|secret[ _-]?key|client[ _-]?secret`;
/** Common words that can follow "seed phrase" in talk about one ("never share my seed phrase with anyone"). */
const PHRASE_TALK = new Set(
  "with to on in for and or is was be are the a an my your our any anyone anywhere anybody safe safely online again ever never without unless if when because before after into from somewhere someone please it this that here there written stored saved backed kept".split(" ")
);

/** "seed phrase apple banana cherry …": eight or more plain words written out after the name. */
function hasWrittenPhrase(text: string): boolean {
  for (const match of text.matchAll(/\b(?:seed|recovery|secret|mnemonic|wallet) (?:phrase|words)\b\s*(?:is|was|=|:|-)?\s*([^.\n]*)/gi)) {
    const words = match[1].toLowerCase().split(/[\s,]+/).filter(Boolean);
    let run = 0;
    for (const word of words) {
      if (!/^[a-z]{3,8}$/.test(word) || PHRASE_TALK.has(word)) break;
      run += 1;
    }
    if (run >= 8) return true;
  }
  return false;
}

const RULES: Array<[SensitiveReason, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bprivate key\b\s*(?:is|=|:)/i],
  ["secret phrase", new RegExp(String.raw`\b(seed|recovery|secret|mnemonic|wallet) (phrase|words)${IS}\S+`, "i")],
  ["recovery code", named(String.raw`(?:recovery|backup) codes?`, "[A-Z0-9-]{4,}", String.raw`(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,}\b`)],
  ["verification code", named(CODE, String.raw`\d{4,8}\b`, String.raw`\d{4,8}\b`)],
  // A bare "code is 482913", but not a postal, area, promo or discount code.
  ["verification code", new RegExp(String.raw`(?<!\b(?:pin|zip|postal|post|area|std|dial|country|promo|coupon|discount|voucher|referral|product|item|hs|hsn|sac|ifsc|swift|sort|class|course|error|status)\s?)\bcode${IS}\d{4,8}\b`, "i")],
  ["verification code", reversed(String.raw`\d{4,8}`, CODE)],
  ["password", named(PASSWORD, String.raw`\S+`)],
  ["password", reversed(SECRETISH, PASSWORD)],
  ["PIN", named(PIN, String.raw`\d{3,8}\b`, String.raw`\d{4,8}\b`)],
  ["PIN", reversed(String.raw`\d{4,8}`, PIN)],
  ["payment card number", new RegExp(String.raw`\b(cvv|cvc|card (?:number|no\.?))${IS}\d`, "i")],
  ["payment card number", /\b(?:cvv|cvc)\s+\d{3,4}\b/i],
  [
    "API key or access token",
    new RegExp(
      [
        String.raw`\b(${KEY_NAMES}|token|secret)${IS}\S{6,}`,
        String.raw`\b(?:${KEY_NAMES})\s+(?=\S*\d)\S{8,}`,
        String.raw`\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}`,
        String.raw`\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}`,
        String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
        String.raw`\bAKIA[0-9A-Z]{16}\b`,
        String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
        String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
        String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{16,}`
      ].join("|"),
      "i"
    )
  ],
  ["API key or access token", reversed(String.raw`(?=\S*\d)\S{8,}`, KEY_NAMES)],
  ["session cookie", /\b(session[ _-]?(id|cookie|token)|cookie|sessionid|PHPSESSID|JSESSIONID)\s*(?:is|=|:)\s*\S{8,}/i],
  ["session cookie", /\b(session[ _-]?(id|cookie|token)|sessionid|PHPSESSID|JSESSIONID)\s+(?=\S*\d)[A-Za-z0-9._%-]{8,}/i],
  [
    "ID or account number",
    /\b(ssn|social security( number)?|aadhaa?r( number| no\.?)?|pan( card| number| no\.?)?|passport( number| no\.?)?|bank account( number| no\.?)?|account (number|no\.?)|a\/c( no\.?)?|iban|routing number)\b[^.\n\d]{0,12}[A-Z]{0,5}\d[\dA-Z -]{4,}/i
  ],
  ["ID or account number", /\b\d{3}-\d{2}-\d{4}\b|\b\d{4} \d{4} \d{4}\b/]
];

/** A run of 13 to 19 digits (spaces or dashes allowed) that passes the card check digit. */
function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** Is this safe to keep? If not, which kind of secret it looks like. */
export function checkSensitive(text: string): SafetyCheck {
  for (const [reason, pattern] of RULES) if (pattern.test(text)) return { allowed: false, reason };
  if (hasWrittenPhrase(text)) return { allowed: false, reason: "secret phrase" };
  if (hasCardNumber(text)) return { allowed: false, reason: "payment card number" };
  return { allowed: true };
}

export function isSafeToRemember(text: string): boolean {
  return checkSensitive(text).allowed;
}

const ARTICLE: Record<SensitiveReason, string> = {
  password: "a password",
  PIN: "a PIN",
  "verification code": "a verification code",
  "recovery code": "a recovery code",
  "API key or access token": "an API key or access token",
  "session cookie": "a login cookie",
  "private key": "a private key",
  "secret phrase": "a secret recovery phrase",
  "payment card number": "a card number",
  "ID or account number": "an ID or account number"
};

/** The same plain message everywhere: "That looks like a password, so I won't save it." */
export function refusalMessage(reason: SensitiveReason, subject = "That"): string {
  return `${subject} looks like ${ARTICLE[reason]}, so ${subject === "That" ? "I won't save it" : "nothing was saved"}.`;
}

/** A form field whose value is a secret (it is asked for each time, never kept in a Skill). */
export const SECRET_FIELD_NAME =
  /(password|passcode|passwd|passphrase|secret|token|\botp\b|one[- ]time|verification code|security code|\bpin\b|\bcvv\b|\bcvc\b|\bcard\b|card number|api key)/i;
