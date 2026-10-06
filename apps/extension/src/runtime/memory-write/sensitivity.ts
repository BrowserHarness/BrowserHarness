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

const RULES: Array<[SensitiveReason, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bprivate key\b\s*(?:is|=|:)/i],
  ["secret phrase", new RegExp(String.raw`\b(seed|recovery|secret|mnemonic|wallet) (phrase|words)${IS}\S+`, "i")],
  ["recovery code", new RegExp(String.raw`\b(recovery|backup) codes?${IS}[A-Z0-9-]{4,}`, "i")],
  ["verification code", new RegExp(String.raw`\b(otp|one[- ]time (?:pass(?:word|code)|code)|verification code|security code|2fa code|login code|auth(?:entication)? code|code)${IS}\d{4,8}\b`, "i")],
  ["password", new RegExp(String.raw`\b(password|passcode|passwd|passphrase|pwd)${IS}\S+`, "i")],
  ["PIN", new RegExp(String.raw`\b(pin|atm pin|upi pin)${IS}\d{3,8}\b`, "i")],
  ["payment card number", new RegExp(String.raw`\b(cvv|cvc|card (?:number|no\.?))${IS}\d`, "i")],
  [
    "API key or access token",
    new RegExp(
      [
        String.raw`\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|bearer[ _-]?token|secret[ _-]?key|client[ _-]?secret|token|secret)${IS}\S{6,}`,
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
  ["session cookie", /\b(session[ _-]?(id|cookie|token)|cookie|sessionid|PHPSESSID|JSESSIONID)\s*(?:is|=|:)\s*\S{8,}/i],
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
