// A durable MemoryStore for the example — SQLite (better-sqlite3), reusing the
// same `.data/app.db` the notes live in, scoped per tenant + user. This is the
// concrete answer to "where does memory get saved": on disk, in rows filtered by
// who's asking.
//
// Scoring is plain keyword overlap so the demo stays dependency-free. Swap in
// `sqlite-vec` + an embedding call for semantic recall — the dendra `MemoryStore`
// interface is identical, so `ctx.memory` and every call site stay exactly the
// same.

import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { MemoryStore, MemoryRecord } from "dendra";

type DB = Database.Database;
const g = globalThis as unknown as { __dendraMemoryDb?: DB };

function getDb(): DB {
  if (g.__dendraMemoryDb) return g.__dendraMemoryDb;
  mkdirSync(".data", { recursive: true });
  const sqlite = new Database(".data/app.db");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      text TEXT NOT NULL, kind TEXT, meta TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_scope ON memories (tenant_id, user_id);
  `);
  g.__dendraMemoryDb = sqlite;
  return sqlite;
}

interface Row {
  id: string;
  text: string;
  kind: string | null;
  meta: string | null;
  created_at: number;
}

const rid = () => "m" + Math.random().toString(36).slice(2, 9);
const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function toRecord(r: Row): MemoryRecord {
  return {
    id: r.id,
    text: r.text,
    kind: r.kind ?? undefined,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
    createdAt: r.created_at,
  };
}

/** A tenant + user-scoped MemoryStore backed by SQLite. */
export function createSqliteMemory(tenantId: string, userId: string): MemoryStore {
  const db = getDb();
  return {
    async save(text, opts) {
      const rec: MemoryRecord = {
        id: rid(),
        text,
        kind: opts?.kind,
        meta: opts?.meta,
        createdAt: Date.now(),
      };
      db.prepare(
        `INSERT INTO memories (id, tenant_id, user_id, text, kind, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rec.id,
        tenantId,
        userId,
        text,
        rec.kind ?? null,
        rec.meta ? JSON.stringify(rec.meta) : null,
        rec.createdAt,
      );
      return { ...rec };
    },

    async search(query, opts) {
      const toks = [...new Set(tokenize(query))];
      if (!toks.length) return [];
      const rows = (
        opts?.kind
          ? db.prepare(
              `SELECT * FROM memories WHERE tenant_id = ? AND user_id = ? AND kind = ?`,
            ).all(tenantId, userId, opts.kind)
          : db.prepare(
              `SELECT * FROM memories WHERE tenant_id = ? AND user_id = ?`,
            ).all(tenantId, userId)
      ) as Row[];
      const k = opts?.k ?? 5;
      const minScore = opts?.minScore ?? 0;
      return rows
        .map((r) => {
          const rt = tokenize(r.text);
          const hits = rt.reduce((n, w) => n + (toks.includes(w) ? 1 : 0), 0);
          const score = rt.length ? hits / Math.sqrt(rt.length * toks.length) : 0;
          return { ...toRecord(r), score };
        })
        .filter((r) => (r.score ?? 0) > minScore)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, k);
    },

    async forget(id) {
      const info = db
        .prepare(
          `DELETE FROM memories WHERE id = ? AND tenant_id = ? AND user_id = ?`,
        )
        .run(id, tenantId, userId);
      return info.changes > 0;
    },

    async all() {
      const rows = db
        .prepare(
          `SELECT * FROM memories WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC`,
        )
        .all(tenantId, userId) as Row[];
      return rows.map(toRecord);
    },
  };
}
