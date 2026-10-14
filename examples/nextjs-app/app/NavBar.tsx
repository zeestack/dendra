"use client";

// Shared top navigation across the example's pages. Lives in the root layout so
// every page gets it. usePathname highlights the active page.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { ApiKeyDialog } from "./ApiKeyDialog";
import s from "./nav.module.css";

const PAGES = [
  { href: "/", label: "Home" },
  { href: "/demo", label: "RPC Demo" },
  { href: "/chat", label: "Chat" },
  { href: "/assistant", label: "Assistant" },
  { href: "/connect", label: "Connect Claude" },
];

export function NavBar() {
  const path = usePathname();
  return (
    <nav className={s.nav}>
      <Link href="/" className={s.brand}>
        <Logo size={26} />
        <span className={s.word}>dendra</span>
      </Link>
      <div className={s.links}>
        {PAGES.map((p) => {
          const active = p.href === "/" ? path === "/" : path.startsWith(p.href);
          return (
            <Link
              key={p.href}
              href={p.href}
              className={`${s.link} ${active ? s.active : ""}`}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      <div className={s.spacer} />
      <ApiKeyDialog />
      <ThemeToggle />
      <a
        className={s.gh}
        href="https://github.com/zeestack/dendra"
        target="_blank"
        rel="noreferrer"
      >
        <svg className={s.ghIcon} viewBox="0 0 16 16" aria-hidden>
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        <span className={s.ghLabel}>GitHub</span>
      </a>
    </nav>
  );
}
