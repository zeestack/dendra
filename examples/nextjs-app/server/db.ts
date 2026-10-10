// Stand-in data layer. Swap for Prisma/Drizzle/etc. — nexus-rpc doesn't care.
//
// Every query is scoped by tenantId (from ctx) so tenants never see each other's
// data. With a real DB this is a WHERE clause (or a schema/row-level-security
// policy); here it's an in-memory filter. Cached on `globalThis` so all of Next's
// per-route module instances share one store in dev.

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

const g = globalThis as unknown as {
  __nexusNotes?: Note[];
  __nexusUsers?: User[];
};
const store: Note[] = (g.__nexusNotes ??= []);
const userStore: User[] = (g.__nexusUsers ??= []);

export const db = {
  notes: {
    // Scoped per TENANT (a shared workspace) — not per user — so a note created
    // by Claude (via MCP) and viewed in the browser line up as long as the
    // tenant matches. userId is still stored for display/attribution.
    all: async (tenantId: string): Promise<Note[]> =>
      store.filter((n) => n.tenantId === tenantId),
    insert: async (
      tenantId: string,
      userId: string,
      input: { title: string; body: string },
    ): Promise<Note> => {
      const note: Note = {
        id: "note_" + Math.random().toString(36).slice(2, 8),
        tenantId,
        userId,
        title: input.title,
        body: input.body,
        createdAt: Date.now(),
      };
      store.push(note);
      return note;
    },
    // Tenant-scoped delete: only removes a note that belongs to this tenant.
    remove: async (tenantId: string, id: string): Promise<boolean> => {
      const i = store.findIndex((n) => n.tenantId === tenantId && n.id === id);
      if (i === -1) return false;
      store.splice(i, 1);
      return true;
    },
  },
  users: {
    all: async (tenantId: string): Promise<User[]> =>
      userStore.filter((u) => u.tenantId === tenantId),
    find: async (tenantId: string, id: string): Promise<User | null> =>
      userStore.find((u) => u.tenantId === tenantId && u.id === id) ?? null,
    insert: async (
      tenantId: string,
      input: { name: string; email: string },
    ): Promise<User> => {
      const user: User = {
        id: "usr_" + Math.random().toString(36).slice(2, 8),
        tenantId,
        name: input.name,
        email: input.email,
      };
      userStore.push(user);
      return user;
    },
  },
};
