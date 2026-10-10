// Real data layer: Drizzle ORM over SQLite (better-sqlite3). The exported `db`
// keeps the EXACT SAME interface the in-memory stub had, so nothing else in the
// app changed — this is the "swap the stub for a real DB" moment. Every query is
// still scoped by tenantId. The connection is cached on globalThis so Next's
// dev-mode module reloads reuse one connection; the DB file lives in .data/.

import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { notes as notesTable, users as usersTable } from "./schema.ts";

export interface Note {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  body: string;
  createdAt: number;
}

export type NoteEvent =
  | { type: "created"; note: Note }
  | { type: "deleted"; id: string };

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
}

type Drizzle = ReturnType<typeof drizzle>;
const g = globalThis as unknown as { __nexusDrizzle?: Drizzle };

function getDb(): Drizzle {
  if (g.__nexusDrizzle) return g.__nexusDrizzle;
  mkdirSync(".data", { recursive: true });
  const sqlite = new Database(".data/app.db");
  sqlite.pragma("journal_mode = WAL");
  // Bootstrap tables (idempotent) — avoids a separate migration step for the demo.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      name TEXT NOT NULL, email TEXT NOT NULL
    );
  `);
  g.__nexusDrizzle = drizzle(sqlite);
  return g.__nexusDrizzle;
}

const id = (p: string) => p + Math.random().toString(36).slice(2, 8);

export const db = {
  notes: {
    all: async (tenantId: string): Promise<Note[]> =>
      getDb().select().from(notesTable).where(eq(notesTable.tenantId, tenantId)).all(),
    insert: async (
      tenantId: string,
      userId: string,
      input: { title: string; body: string },
    ): Promise<Note> => {
      const note: Note = {
        id: id("note_"),
        tenantId,
        userId,
        title: input.title,
        body: input.body,
        createdAt: Date.now(),
      };
      getDb().insert(notesTable).values(note).run();
      return note;
    },
    remove: async (tenantId: string, noteId: string): Promise<boolean> => {
      const res = getDb()
        .delete(notesTable)
        .where(and(eq(notesTable.tenantId, tenantId), eq(notesTable.id, noteId)))
        .run();
      return res.changes > 0;
    },
  },
  users: {
    all: async (tenantId: string): Promise<User[]> =>
      getDb().select().from(usersTable).where(eq(usersTable.tenantId, tenantId)).all(),
    find: async (tenantId: string, userId: string): Promise<User | null> => {
      const rows = getDb()
        .select()
        .from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.id, userId)))
        .all();
      return rows[0] ?? null;
    },
    insert: async (
      tenantId: string,
      input: { name: string; email: string },
    ): Promise<User> => {
      const user: User = {
        id: id("usr_"),
        tenantId,
        name: input.name,
        email: input.email,
      };
      getDb().insert(usersTable).values(user).run();
      return user;
    },
  },
};
