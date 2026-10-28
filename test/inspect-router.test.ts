import { describe, it, expect } from "vitest";
import {
  initDendra,
  inspectRouter,
  createCaller,
  DendraError,
  s,
} from "../src/index.ts";

interface Ctx {
  tenantId?: string;
  role?: string;
}
interface Meta {
  restricted?: "approver" | "admin";
  audit?: boolean;
}
const { route } = initDendra<Ctx, Meta>();

// A named function reports its own name; an inline one can be named at .use().
const tenant = ({ ctx }: { ctx: Ctx }) => {
  if (!ctx.tenantId) throw new DendraError("UNAUTHORIZED", "No tenant");
  return { tenantId: ctx.tenantId };
};
const scoped = route.use(tenant);

class PostsController {
  publish = scoped
    .use(
      ({ ctx }) => {
        if (ctx.role !== "approver") throw new DendraError("FORBIDDEN", "No");
      },
      { name: "role:approver" },
    )
    .meta({ restricted: "approver" })
    .post("/posts/publish")
    .handler(() => "published");
}

const router = {
  posts: new PostsController(),
  notes: {
    list: scoped.get("/notes").handler(() => []),
    create: scoped
      .input(s.object({ title: s.string() }))
      .meta({ audit: true })
      .ai({ description: "Create a note" })
      .handler(({ input }) => input.title),
    watch: scoped.use(() => {}).stream(async function* () {
      yield 1;
    }),
  },
  ping: route.handler(() => "pong"),
};

describe("inspectRouter", () => {
  it("lists every procedure with its path, kind, method, REST path, and AI flag", () => {
    const byPath = Object.fromEntries(inspectRouter(router).map((p) => [p.path, p]));
    expect(Object.keys(byPath)).toEqual([
      "posts.publish",
      "notes.list",
      "notes.create",
      "notes.watch",
      "ping",
    ]);
    expect(byPath["notes.list"]).toMatchObject({
      kind: "unary",
      method: "GET",
      restPath: "/notes",
      ai: false,
    });
    expect(byPath["notes.create"]).toMatchObject({ method: "POST", ai: true });
    expect(byPath["notes.create"].restPath).toBeUndefined();
    expect(byPath["notes.watch"].kind).toBe("stream");
    expect(byPath["posts.publish"].restPath).toBe("/posts/publish");
  });

  it("names middlewares in order: explicit name, else the function's name", () => {
    const byPath = Object.fromEntries(inspectRouter(router).map((p) => [p.path, p]));
    expect(byPath["posts.publish"].middlewares).toEqual(["tenant", "role:approver"]);
    expect(byPath["notes.watch"].middlewares).toEqual(["tenant", "anonymous"]);
    expect(byPath["ping"].middlewares).toEqual([]);
  });

  it("reports meta, merged across .meta() calls, and {} when unset", () => {
    const merged = route.meta({ restricted: "admin" }).meta({ audit: true }).handler(() => 1);
    const [p] = inspectRouter({ merged });
    expect(p.meta).toEqual({ restricted: "admin", audit: true });
    const byPath = Object.fromEntries(inspectRouter(router).map((p) => [p.path, p]));
    expect(byPath["ping"].meta).toEqual({});
    expect(byPath["posts.publish"].meta).toEqual({ restricted: "approver" });
  });

  it("supports the guard-check test from the issue", () => {
    for (const p of inspectRouter<Meta>(router)) {
      if (p.path === "ping") continue;
      expect(p.middlewares, p.path).toContain("tenant");
      if (p.meta.restricted) {
        expect(p.middlewares, p.path).toContain(`role:${p.meta.restricted}`);
        expect(p.ai, p.path).toBe(false);
      }
    }
  });

  it("naming a middleware doesn't change how it runs", async () => {
    const c = createCaller(router, { tenantId: "t1", role: "viewer" });
    await expect(c.posts.publish()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = createCaller(router, { tenantId: "t1", role: "approver" });
    expect(await ok.posts.publish()).toBe("published");
  });
});
