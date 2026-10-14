"use client";

// Light/dark toggle. Sets data-theme on <html> (which globals.css reads) and
// persists the choice. The no-FOUC script in the layout applies the saved theme
// before first paint; this just flips and stores it.

import { useEffect, useState } from "react";
import s from "./nav.module.css";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    const initial: Theme =
      attr === "light" || attr === "dark"
        ? attr
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial);
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* storage blocked — the choice just won't persist */
    }
  }

  return (
    <button
      className={s.iconBtn}
      onClick={toggle}
      aria-label="Toggle color theme"
      title="Toggle theme"
    >
      {/* Before mount, render nothing to avoid a hydration mismatch. */}
      {mounted &&
        (theme === "dark" ? (
          <svg className={s.icon} viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        ) : (
          <svg className={s.icon} viewBox="0 0 24 24" aria-hidden>
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        ))}
    </button>
  );
}
