// Speak a request (Chrome speech recognition) and hear answers read aloud.

interface RecognitionResult {
  0: { transcript: string };
  isFinal: boolean;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

export function dictationAvailable(): boolean {
  return recognitionClass() !== null;
}

/**
 * Listen and report the words as they come. Returns a function that stops
 * listening. `onError("not-allowed")` means the microphone is blocked.
 */
export function startDictation({
  onText,
  onEnd,
  onError,
  lang = navigator.language || "en-US"
}: {
  onText: (text: string, final: boolean) => void;
  onEnd: () => void;
  onError: (error: string) => void;
  lang?: string;
}): () => void {
  const Recognition = recognitionClass();
  if (!Recognition) {
    onError("unsupported");
    onEnd();
    return () => undefined;
  }
  const recognition = new Recognition();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    onText((finalText + interim).trim(), interim === "");
  };
  recognition.onerror = (event) => onError(event.error);
  recognition.onend = onEnd;
  recognition.start();
  return () => recognition.stop();
}

/** Markdown to something pleasant to hear. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speak(markdown: string): void {
  if (!("speechSynthesis" in globalThis)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakableText(markdown));
  utterance.lang = navigator.language || "en-US";
  speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in globalThis) speechSynthesis.cancel();
}
