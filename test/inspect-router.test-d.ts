import { expectTypeOf } from "vitest";
import { initDendra, inspectRouter, type RouteInfo } from "../src/index.ts";

// `.meta()` is typed by initDendra's second parameter; calls may set any subset.
const { route } = initDendra<{ user?: string }, { restricted?: "approver"; audit?: boolean }>();

route.meta({ restricted: "approver" }).meta({ audit: true }).handler(() => 1);
// @ts-expect-error — not a declared meta key
route.meta({ nope: 1 });
// @ts-expect-error — wrong value type
route.meta({ restricted: "admin" });

// Naming a middleware keeps its ctx contribution typed.
route
  .use(() => ({ tenantId: "t" }), { name: "tenant" })
  .handler(({ ctx }) => {
    expectTypeOf(ctx.tenantId).toEqualTypeOf<string>();
  });

// Without a Meta argument, meta stays an open record.
const { route: plain } = initDendra<{ user?: string }>();
plain.meta({ anything: 1 });

const infos = inspectRouter<{ restricted?: "approver" }>({ x: plain.handler(() => 1) });
expectTypeOf(infos).toEqualTypeOf<RouteInfo<{ restricted?: "approver" }>[]>();
expectTypeOf(infos[0].meta.restricted).toEqualTypeOf<"approver" | undefined>();
expectTypeOf(inspectRouter({})[0].meta).toEqualTypeOf<Record<string, unknown>>();
