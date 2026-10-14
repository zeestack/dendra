"use client";

// "Bring your own key" — a nav button + modal to enter an Anthropic API key for
// the Chat and Assistant demos. The key lives in this browser (localStorage) and
// is sent as a request header to this app's own server, which uses it per-request
// and never stores it. See lib/api.ts.

import { useEffect, useState } from "react";
import { setAnthropicKey, getAnthropicKey } from "@/lib/api";
import s from "./nav.module.css";

export function ApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    setHasKey(Boolean(getAnthropicKey()));
  }, [open]);

  function openDialog() {
    setValue(getAnthropicKey());
    setOpen(true);
  }
  function save() {
    setAnthropicKey(value || null);
    setOpen(false);
  }
  function remove() {
    setAnthropicKey(null);
    setValue("");
    setHasKey(false);
    setOpen(false);
  }

  return (
    <>
      <button
        className={s.iconBtn}
        onClick={openDialog}
        title={hasKey ? "Anthropic key set — click to change" : "Add your Anthropic API key"}
        aria-label="API key"
      >
        <svg className={s.icon} viewBox="0 0 24 24" aria-hidden>
          <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L21 4" />
          <path d="m21 2-9.6 9.6" />
          <circle cx="7.5" cy="15.5" r="5.5" />
        </svg>
        {hasKey && <span className={s.keyDot} aria-hidden />}
      </button>

      {open && (
        <div className={s.overlay} onClick={() => setOpen(false)}>
          <div
            className={s.modal}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Anthropic API key"
          >
            <h3 className={s.modalTitle}>Bring your own Anthropic key</h3>
            <p className={s.modalText}>
              Use your own API key for the Chat and Assistant demos. It's stored
              in <strong>this browser only</strong> and sent with each request to
              this app's server, which uses it for that call and never logs or
              saves it.
            </p>
            <input
              className={s.modalInput}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="sk-ant-…"
              autoFocus
              spellCheck={false}
            />
            <div className={s.modalRow}>
              {hasKey && (
                <button className={s.modalGhost} onClick={remove}>
                  Remove
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button className={s.modalGhost} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className={s.modalPrimary} onClick={save}>
                Save
              </button>
            </div>
            <a
              className={s.modalLink}
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              Get a key ↗
            </a>
          </div>
        </div>
      )}
    </>
  );
}
