// Browser voice input (SpeechRecognition — Chrome/Edge, over HTTPS/localhost).
// Returns `supported` only after mount so SSR and the first client render agree.

import { useEffect, useState } from "react";

export function useVoice(onTranscript: (text: string) => void) {
  const [mounted, setMounted] = useState(false);
  const [listening, setListening] = useState(false);
  useEffect(() => setMounted(true), []);

  const supported =
    mounted &&
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  function start() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => onTranscript(String(e.results[0][0].transcript));
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }

  return { supported, listening, start };
}
