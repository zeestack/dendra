// Per-request context — where auth/session/db live in a real app. dendra never
// authenticates; it runs handlers with whatever ctx you build here. This starter
// uses an in-memory store so it runs with no database setup.

export interface Note {
  id: string;
  title: string;
  body: string;
}

const notes: Note[] = [];

export const db = {
  notes: {
    all: (): Note[] => notes,
    create: (input: { title: string; body: string }): Note => {
      const note: Note = { id: Math.random().toString(36).slice(2, 9), ...input };
      notes.push(note);
      return note;
    },
  },
};

export interface Ctx {
  db: typeof db;
}

export function createContext(): Ctx {
  return { db };
}
