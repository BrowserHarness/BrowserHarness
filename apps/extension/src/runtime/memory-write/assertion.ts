// Said by the person about themselves, or only written down by them?
//
// A message can carry other people's words: a quotation, an example, copied
// text, a transcript, code, "my friend said …", "the page says …". Those words
// are in the message but the person is not asserting them, so automatic
// memory must not learn from them. This keeps only the parts of a message
// that read as the person's own statement, using fixed word rules (no model
// call, nothing sent anywhere). It leans towards dropping: a missed memory
// costs a little, a wrong one is kept and used.
//
// Explicit requests (/remember, /decide, the About you and Decisions screens)
// don't go through this: the person asked for exactly those words to be kept.

/** Someone else's words follow: "my friend said", "the page says", "according to". */
const REPORTED =
  /\b(said|says|told( me| us)?|tells( me| us)?|wrote|writes|replied|replies|mentioned|quoted|quotes|tweeted|according to|in (his|her|their|its) words)\b/i;

/** An example, a quotation or a what-if starts here. */
const FRAME_START =
  /^(for example|for instance|e\.g\.?|eg\b|example|examples|sample|as an example|an example|suppose|supposing|imagine|pretend|hypothetically|let's say|let us say|say that|what if|if i (said|say|told|wrote|were|was)|quote|transcript)\b/i;

/** People other than the person: "my friend lives in Delhi" is about the friend. */
const PEOPLE =
  "friend|friends|boss|wife|husband|partner|girlfriend|boyfriend|mom|mum|mother|dad|father|parents|brother|sister|son|daughter|kids?|children|child|colleague|coworker|co-worker|manager|client|customer|neighbou?r|cousin|uncle|aunt|grandma|grandmother|grandpa|grandfather|teacher|student|roommate|flatmate|family|team ?mate|teammate|cofounder|co-founder|landlord|doctor|dentist";
/** "My manager is Priya" is about the person (who their manager is); "my manager lives in Delhi" is not. */
const OTHER_PERSON = new RegExp(
  String.raw`^(?:(?:my|our|his|her|their)\s+(?:${PEOPLE})(?:'s|’s)?\b(?!\s+(?:is|was)\s+(?:called\s+|named\s+)?[A-Z])|(?:he|she|they|someone|somebody|everyone|everybody|people|nobody)\b)`,
  "i"
);
/** Someone named: "Rahul lives in Delhi". */
const NAMED_PERSON = /^(?!I\b)[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s+(?:lives|lived|prefers|likes|loves|hates|uses|works|wants|thinks|believes|drives|eats|needs|stays)\b/;
/** The person speaking again after someone else ("…, but I live in Mumbai"). */
const SELF_SUBJECT = /^(i|i'm|i’m|i've|i'd|i'll|my|me|we|we're|we'll|we've|let's|our|call me)\b/i;

/** "Example:", "Boss:", "Translate this:" at the start of a line, but not "Note:" or "Remember:". */
const LABEL = /^\s*([\p{L}][\p{L}' .-]{0,30}?)\s*:\s*/u;
const OWN_LABELS = /^(note|notes|fyi|update|ps|p\.s|btw|also|remember|reminder|context|important|background|about me|decision|decided)$/i;
const LABEL_IS_SELF = /^(my|i|our|we)\b/i;

/** Quoted spans of three words or more ("I live in Delhi"); a short name in quotes ("Neo") stays. */
function withoutQuotations(text: string): string {
  return text.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]|‘[^’\n]*’/g, (span) =>
    // A quoted sentence that ends inside the quotes still ends the sentence: what follows is the person again.
    span.trim().split(/\s+/).length >= 3 ? (/[.!?]\s*["”»“’]$/.test(span) ? " . " : " ") : span
  );
}

/** The person's own part of one sentence: everything up to where someone else's words, an example or another person begins. */
function ownPartOfSentence(sentence: string): string {
  const clauses = sentence.split(/(?<=[,;])\s+|\s+(?=(?:but|and|while|whereas|although|though)\s)/i);
  const kept: string[] = [];
  let other = false;
  for (const clause of clauses) {
    const body = clause.replace(/^(?:but|and|while|whereas|although|though)\s+/i, "").trim();
    if (!body) continue;
    // From a reported-speech verb or an example on, the rest of the sentence is someone else's.
    if (FRAME_START.test(body) || REPORTED.test(body)) break;
    if (OTHER_PERSON.test(body) || NAMED_PERSON.test(body)) {
      other = true;
      continue;
    }
    if (SELF_SUBJECT.test(body)) other = false;
    if (!other) kept.push(kept.length ? clause.trim() : body);
  }
  return kept.join(" ").replace(/[,;]\s*$/, "").trim();
}

/**
 * The parts of a message the person asserts about themselves and their own
 * work, sentence by sentence (one per line). Quotations, examples, code,
 * transcripts and reported speech are left out.
 */
export function selfAssertedText(message: string): string {
  const text = withoutQuotations(
    message
      .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
      .replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n\n")
      .replace(/`[^`\n]*`/g, " ")
  );
  const own: string[] = [];
  let skipParagraph = false;
  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) {
      skipParagraph = false;
      continue;
    }
    // Quoted blocks, indented code and timestamped transcript lines.
    if (skipParagraph || /^\s*>/.test(rawLine) || /^( {4}|\t)/.test(rawLine) || /^\s*\[?\(?\d{1,2}:\d{2}/.test(rawLine)) continue;
    let line = rawLine.trim();
    const label = LABEL.exec(line);
    if (label && !LABEL_IS_SELF.test(label[1])) {
      if (!OWN_LABELS.test(label[1].trim())) {
        // "Example:" or "Boss:" — and when the line is only the label, the lines under it too.
        if (!line.slice(label[0].length).trim()) skipParagraph = true;
        continue;
      }
    }
    // A line ending in ":" after someone else's words ("My friend said:") introduces their words.
    if (/:\s*$/.test(line) && (REPORTED.test(line) || FRAME_START.test(line))) skipParagraph = true;
    line = line.replace(/:\s*$/, "");
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const part = ownPartOfSentence(sentence.trim());
      if (part && /[\p{L}\p{N}]/u.test(part)) own.push(part);
    }
  }
  return own.join("\n");
}

/** Is this sentence (all of it) the person's own statement? */
export function isSelfAssertion(sentence: string): boolean {
  const own = selfAssertedText(sentence).replace(/\s+/g, " ").trim();
  return own.length > 0 && own === sentence.replace(/\s+/g, " ").trim().replace(/:\s*$/, "");
}
