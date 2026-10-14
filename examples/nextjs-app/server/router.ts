// The single source of truth. Each procedure becomes: an RPC call, a REST
// endpoint (where a path is given), an OpenAPI entry, a typed client method, and
// — where `.ai()` is set — an LLM tool. Define once, consume everywhere.

import {
  initDendra,
  s,
  toToolSource,
  mergeToolsets,
  DendraError,
  type RouterRecord,
} from "dendra";
import type { Ctx } from "./context.ts";
import type { Note, NoteEvent } from "./db.ts";
import { db } from "./db.ts";
import { streamChat, streamAssistant, summarize } from "./llm.ts";
import {
  getExternalToolSources,
  listMcpServers,
  connectMcpServer,
  disconnectMcpServer,
} from "./mcp-tools.ts";
import type { McpServerInfo, ConnectResult } from "./mcp-tools.ts";
import type { ChatPart } from "../lib/chat-types.ts";
import { UsersController } from "./users.controller.ts";

const { route } = initDendra<Ctx>();

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
          throw new DendraError("NOT_FOUND", `Note '${input.id}' not found`);
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

  // Long-term memory — the same define-once procedure, now over ctx.memory
  // (SQLite, scoped per user in context.ts). `.ai()` makes each one a tool Claude
  // can call over MCP, so the model can remember and recall across sessions.
  memory: {
    remember: route
      .input(s.object({ text: s.string() }))
      .ai({ description: "Save a durable fact about the user for later recall" })
      .handler(({ input, ctx }) => ctx.memory.save(input.text, { kind: "fact" })),

    recall: route
      .input(s.object({ query: s.string() }))
      .ai({ description: "Recall facts relevant to a query from memory" })
      .handler(({ input, ctx }) => ctx.memory.search(input.query, { k: 5 })),

    list: route
      .get("/memory")
      .ai({ description: "List everything remembered about the current user" })
      .handler(({ ctx }) => ctx.memory.all?.() ?? []),

    forget: route
      .input(s.object({ id: s.string() }))
      .ai({ description: "Forget a specific memory by its id" })
      .handler(({ input, ctx }) => ctx.memory.forget(input.id)),
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
          "memory.remember — save a durable fact about the user { text }",
          "memory.recall — recall facts relevant to a query { query }",
          "memory.list — list everything remembered about this user",
          "memory.forget — forget a memory by { id }",
          "ai.summarize — summarize a piece of text into one sentence",
          "ext.weather.get — (external MCP tool) current weather for a city",
          "ext.time.now — (external MCP tool) the current server time",
        ],
      })),
  },

  mcp: {
    // UI-only (no .ai()): manage external MCP connections from the app. Not
    // exposed to the model — these drive the "connectors" panel, not the agent.

    // List every connected MCP server and the tools it exposes.
    servers: route.handler((): Promise<McpServerInfo[]> => listMcpServers()),

    // Add a connector: connect a remote MCP server by URL (Streamable HTTP).
    // Returns { status: "auth_required", authorizeUrl } if the server needs OAuth.
    connect: route
      .input(s.object({ url: s.string(), name: s.optional(s.string()) }))
      .handler(({ input, ctx }): Promise<ConnectResult> =>
        connectMcpServer({ ...input, origin: ctx.origin }),
      ),

    // Remove a connector.
    disconnect: route
      .input(s.object({ id: s.string() }))
      .handler(async ({ input }) => {
        await disconnectMcpServer(input.id);
        return { disconnected: true, id: input.id };
      }),
  },

  ui: {
    // A CLIENT-side action exposed as a tool: the server handler just echoes the
    // target path; the assistant page acts on it (router.push). Lets the model
    // drive the UI ("navigate to the home page").
    navigate: route
      .input(s.object({ to: s.string() }))
      .ai({
        description:
          "Navigate the app to a path. Valid paths: '/', '/demo', '/chat', '/assistant'.",
      })
      .handler(({ input }) => ({ to: input.to })),
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
      .input(
        s.object({
          // The full conversation so far — the server is stateless, so the client
          // sends history each turn (like the Messages API). This is what gives
          // the assistant continuity ("validate your earlier claim" works).
          messages: s.array(
            s.object({ role: s.string(), content: s.string() }),
          ),
        }),
      )
      .stream(async function* ({ input, ctx }): AsyncGenerator<ChatPart> {
        // Local tools (this app's procedures) + tools from every connected
        // EXTERNAL MCP server, merged into one flat toolset. The model can't
        // tell them apart; mergeToolsets routes each call to the owning source.
        const local = toToolSource(appRouter, ctx, { format: "anthropic" });
        const external = await getExternalToolSources("anthropic");
        const merged = mergeToolsets(local, ...external);
        yield* streamAssistant(input.messages as never, {
          tools: merged.tools,
          execute: merged.execute,
          system:
            "You help the user manage notes and navigate the app. Use notes.list/notes.create for notes, users.list/users.create for users, and ui.navigate to move around (paths: '/', '/demo', '/chat', '/assistant'). You have durable MEMORY of the user across sessions: call memory.recall whenever the user asks about themselves or refers to something they told you before (e.g. their name, preferences, where they live), and call memory.remember to save a new durable fact when they tell you one (\"remember that…\", \"my name is…\", \"I prefer…\"); memory.list shows everything saved, memory.forget removes one by id. You also have EXTERNAL tools from a connected MCP server: ext.weather.get (current weather for a city) and ext.time.now (current time) — use them when asked. After a tool runs, give a one-line confirmation. Keep replies brief.",
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
