// Typewriter reveal. The model streams text in token-sized bursts; this smooths
// it into a character-by-character reveal (like Claude's UI). It catches up when
// a lot of text arrives at once (so it never lags far behind), and a message
// that mounts already complete — i.e. conversation history — shows instantly.

import { useEffect, useState } from "react";

export function useTypewriter(
  target: string,
  animate = true,
): { text: string; typing: boolean } {
  // Live turns start at 0 and reveal; already-complete messages (history) mount
  // fully shown so they don't re-animate.
  const [shown, setShown] = useState(animate ? 0 : target.length);
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
