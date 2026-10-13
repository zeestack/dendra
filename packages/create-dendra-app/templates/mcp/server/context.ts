// Per-request context — where auth/session/db live in a real app. dendra never
// authenticates; it runs handlers with whatever ctx you build here.
//
// This starter persists notes to a small JSON file (.data/notes.json) so the web
// app and the MCP server — which run as SEPARATE processes — share the same data.
// `notes.watch` streams the list whenever that file changes, so a note Claude
// creates over MCP (from the other process) pushes live into the web UI — over
// dendra's streaming RPC, no polling. (Swap this for a real database + pub/sub,
// e.g. Postgres LISTEN/NOTIFY or Redis, when you outgrow it.)

import { readFileSync, writeFileSync, mkdirSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";

export interface Note {
  id: string;
  title: string;
  body: string;
}

const DATA_DIR = join(process.cwd(), ".data");
const FILE = join(DATA_DIR, "notes.json");

function read(): Note[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Note[];
  } catch {
    return [];
  }
}

function write(notes: Note[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(notes, null, 2));
}

export const db = {
  notes: {
    all: (): Note[] => read(),
    create: (input: { title: string; body: string }): Note => {
      const notes = read();
      const note: Note = { id: Math.random().toString(36).slice(2, 9), ...input };
      notes.push(note);
      write(notes);
      return note;
    },
    // Live stream: yields the full note list now, then again every time the
    // backing file changes — including when the SEPARATE MCP server process
    // writes a note Claude just created. This is what powers the live UI.
    async *watch(signal?: AbortSignal): AsyncGenerator<Note[]> {
      mkdirSync(DATA_DIR, { recursive: true });
      yield read();
      let wake: (() => void) | null = null;
      const bump = () => {
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      };
      const watcher = fsWatch(DATA_DIR, (_evt, name) => {
        if (name === "notes.json") bump();
      });
      signal?.addEventListener("abort", bump, { once: true });
      try {
        while (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          if (signal?.aborted) break;
          yield read();
        }
      } finally {
        watcher.close();
        signal?.removeEventListener("abort", bump);
      }
    },
  },
};

export interface Ctx {
  db: typeof db;
  // Request abort signal — the stream reads it to stop when the client goes away.
  signal?: AbortSignal;
}

export function createContext(req?: Request): Ctx {
  return { db, signal: req?.signal };
}
