// Typewriter reveal. The model streams text in token-sized bursts; this smooths
// it into a character-by-character reveal (like Claude's UI). It catches up when
// a lot of text arrives at once (so it never lags far behind), and a message
// that mounts already complete — i.e. conversation history — shows instantly.

import { useEffect, useState } from "react";

export function useTypewriter(target: string): { text: string; typing: boolean } {
  // Start fully shown so already-complete messages (history) don't re-animate.
  const [shown, setShown] = useState(target.length);
  const visible = Math.min(shown, target.length);

  useEffect(() => {
    if (visible >= target.length) return;
    const behind = target.length - visible;
    // ~2 chars/frame baseline (≈120 cps), accelerating when far behind.
    const step = Math.max(2, Math.ceil(behind / 24));
    const id = setTimeout(
      () => setShown((s) => Math.min(target.length, s + step)),
      16,
    );
    return () => clearTimeout(id);
  }, [visible, target.length]);

  return { text: target.slice(0, visible), typing: visible < target.length };
}
