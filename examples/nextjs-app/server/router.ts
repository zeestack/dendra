// The single source of truth. Each procedure becomes: an RPC call, a REST
// endpoint (where a path is given), an OpenAPI entry, a typed client method, and
// — where `.ai()` is set — an LLM tool. Define once, consume everywhere.

import {
  initNexus,
  s,
  toToolset,
  createToolExecutor,
  NexusError,
  type RouterRecord,
} from "dendra";
import type { Ctx } from "./context.ts";
import type { Note, NoteEvent } from "./db.ts";
import { db } from "./db.ts";
import { streamChat, streamAssistant, summarize } from "./llm.ts";
import type { ChatPart } from "../lib/chat-types.ts";
import { UsersController } from "./users.controller.ts";

const { route } = initNexus<Ctx>();

// Plain-object procedures (keep `satisfies RouterRecord` for authoring safety).
const coreRouter = {
  notes: {
    // RPC + REST: GET /api/notes  — scoped to ctx.tenantId automatically
    // .ai() also exposes it to Claude via MCP.
    list: route
      .get("/notes")
      .ai({ description: "List the notes in the current workspace" })
      .handler(({ ctx }): Promise<Note[]> => ctx.db.notes.all(ctx.tenantId)),

    // RPC + REST: POST /api/notes  — also publishes a tenant-scoped event
    create: route
      .post("/notes")
      .input(s.object({ title: s.string(), body: s.string() }))
      .ai({ description: "Create a note with a title and body" })
      .handler(async ({ input, ctx }): Promise<Note> => {
        const note = await ctx.db.notes.insert(ctx.tenantId, ctx.userId, input);
        // Tenant-scoped topic: every viewer of this workspace gets the event,
        // whoever created the note (you in the UI, or Claude via MCP).
        ctx.pubsub.publish(`notes:${ctx.tenantId}`, {
          type: "created",
          note,
        } satisfies NoteEvent);
        return note;
      }),

    // RPC + REST: DELETE /api/notes/:id  — tenant-scoped, publishes a live event
    delete: route
      .delete("/notes/:id")
      .input(s.object({ id: s.string() }))
      .ai({ description: "Delete a note by its id from the current workspace" })
      .handler(async ({ input, ctx }) => {
        const ok = await ctx.db.notes.remove(ctx.tenantId, input.id);
        if (!ok) {
          throw new NexusError("NOT_FOUND", `Note '${input.id}' not found`);
        }
        ctx.pubsub.publish(`notes:${ctx.tenantId}`, {
          type: "deleted",
          id: input.id,
        } satisfies NoteEvent);
        return { deleted: true, id: input.id };
      }),

    // Subscription: live note stream for this tenant
    watch: route.stream(async function* ({ ctx }): AsyncGenerator<NoteEvent> {
      for await (const ev of ctx.pubsub.subscribe(`notes:${ctx.tenantId}`, {
        signal: ctx.signal,
      })) {
        yield ev as NoteEvent;
      }
    }),
  },

  app: {
    // Grounding tool: lets Claude learn what this app is and what it can do here
    // before acting, instead of guessing.
    info: route
      .ai({
        description:
          "Get information about this app and the actions available. Call this first to ground yourself before answering questions about the app.",
      })
      .handler(({ ctx }) => ({
        app: "dendra-notes",
        description:
          "A multi-tenant notes app built on dendra — a lightweight, decorator-free, codegen-free typed RPC/REST framework for Next.js. One procedure definition becomes an RPC call, a REST endpoint, an OpenAPI schema, a typed client, a streaming subscription, and an MCP tool.",
        currentContext: { tenant: ctx.tenantId, user: ctx.userId },
        actions: [
          "notes.list — list the notes in this workspace",
          "notes.create — create a note { title, body }",
          "notes.delete — delete a note by { id }",
          "users.list — list users in this workspace",
          "users.create — create a user { name, email }",
          "ai.summarize — summarize a piece of text into one sentence",
        ],
      })),
  },

  ai: {
    // Exposed to the model as a tool (opt-in). Runs with the user's context.
    summarize: route
      .input(s.object({ text: s.string() }))
      .ai({ description: "Summarize the given text into one sentence" })
      .handler(async ({ input }) => ({ summary: await summarize(input.text) })),

    // Streaming chat — real LLM tokens (falls back to an echo without a key).
    chat: route
      .input(s.object({ prompt: s.string() }))
      .stream(async function* ({ input, ctx }): AsyncGenerator<string> {
        yield* streamChat(input.prompt, ctx.signal);
      }),

    // Generative-UI assistant: the model calls the notes tools; the stream yields
    // typed PARTS, and the client renders a React component per tool part.
    assistant: route
      .input(s.object({ prompt: s.string() }))
      .stream(async function* ({ input, ctx }): AsyncGenerator<ChatPart> {
        yield* streamAssistant(input.prompt, {
          tools: toToolset(appRouter, { format: "anthropic" }),
          execute: createToolExecutor(appRouter, ctx),
          system:
            "You help the user manage notes. Use notes.list to show their notes and notes.create to add one. After a tool runs, give a one-line confirmation. Keep replies brief.",
          signal: ctx.signal,
        });
      }),
  },
} satisfies RouterRecord;

// Merge a NestJS-style class controller in. A class instance has no index
// signature, so the combined router can't use `satisfies RouterRecord` — the
// consumer functions accept `object` and `Client<AppRouter>` validates the shape.
export const appRouter = {
  ...coreRouter,
  users: new UsersController(db),
};

export type AppRouter = typeof appRouter;
