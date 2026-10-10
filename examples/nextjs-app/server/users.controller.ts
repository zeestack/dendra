// NestJS-style class controller — no decorators. A controller is a class whose
// fields are procedures; an *instance* goes into the router (see router.ts).
// Dependencies are injected via the constructor and kept in #private fields so
// the controller's public shape stays pure procedures.

import { initNexus, s } from "nexus-rpc";
import type { Ctx } from "./context.ts";
import { db } from "./db.ts";
import type { User } from "./db.ts";

const { route } = initNexus<Ctx>();
type Db = typeof db;

export class UsersController {
  #db: Db;
  constructor(database: Db) {
    this.#db = database;
  }

  // GET /api/users  (also an RPC call users.list and an MCP tool users_list)
  list = route
    .get("/users")
    .ai({ description: "List the users in the current workspace" })
    .handler(({ ctx }): Promise<User[]> => this.#db.users.all(ctx.tenantId));

  // POST /api/users
  create = route
    .post("/users")
    .input(s.object({ name: s.string(), email: s.string() }))
    .ai({ description: "Create a user with a name and email" })
    .handler(
      ({ input, ctx }): Promise<User> =>
        this.#db.users.insert(ctx.tenantId, input),
    );

  // GET /api/users/:id
  get = route
    .get("/users/:id")
    .input(s.object({ id: s.string() }))
    .handler(
      ({ input, ctx }): Promise<User | null> =>
        this.#db.users.find(ctx.tenantId, input.id),
    );
}
