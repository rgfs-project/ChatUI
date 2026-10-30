import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Microphone dictation (Phase 15) with the browser's own speech recognition.
 * Offered only where the browser has it. ChatUI never receives the audio:
 * the browser does the recognition, and some browsers send the audio to
 * their vendor's speech service to do it (the composer says so on first use).
 */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const never = () => () => undefined;

/** Whether dictation is available; false on the server and while hydrating. */
export function useDictationSupported(): boolean {
  return useSyncExternalStore(
    never,
    () => recognitionClass() !== null,
    () => false,
  );
}

export type DictationError = "denied" | "no-speech" | "failed";

/**
 * Starts and stops recognition; each finished phrase is handed to `onText`.
 * Stops by itself when the component unmounts (leaving the chat).
 */
export function useDictation(
  onText: (text: string) => void,
  onError: (error: DictationError) => void,
) {
  const [listening, setListening] = useState(false);
  const active = useRef<Recognition | null>(null);
  const handlers = useRef({ onText, onError });
  useEffect(() => {
    handlers.current = { onText, onError };
  });

  const stop = useCallback(() => {
    active.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Recognition = recognitionClass();
    if (!Recognition || active.current) return;
    const recognition = new Recognition();
    recognition.lang = document.documentElement.lang || navigator.language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result?.[0].transcript.trim();
        if (result?.isFinal && text) handlers.current.onText(text);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      handlers.current.onError(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "denied"
          : event.error === "no-speech"
            ? "no-speech"
            : "failed",
      );
    };
    recognition.onend = () => {
      if (active.current === recognition) active.current = null;
      setListening(false);
    };
    active.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      active.current = null;
      handlers.current.onError("failed");
    }
  }, []);

  useEffect(
    () => () => {
      const recognition = active.current;
      active.current = null;
      recognition?.abort();
    },
    [],
  );

  return { listening, start, stop };
}
