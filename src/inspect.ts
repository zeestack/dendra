// Router introspection: a flat, plain-data view of every procedure, so a test
// can fail the build when one lacks its tenant guard or a restricted one is an
// AI tool — without reading builder internals.

import type { AnyProc, HttpMethod, ProcedureKind, RouterRecord } from "./core.ts";

export interface RouteInfo<Meta = Record<string, unknown>> {
  /** Dotted router path, e.g. "notes.create". */
  path: string;
  kind: ProcedureKind;
  method: HttpMethod;
  /** The REST route, when the procedure declared one. */
  restPath?: string;
  /** Middleware names in run order (see `.use(mw, { name })`). */
  middlewares: string[];
  /** Exposed to LLMs / MCP via `.ai()`. */
  ai: boolean;
  /** `.ai({ confirm: true })`: tool calls wait for a person's approval. */
  confirm: boolean;
  /** `.noAi()`: may never be a tool. */
  noAi: boolean;
  /** Merged `.meta()` values; `{}` when none were set. */
  meta: Meta;
}

/** List every procedure in `router` (class-controller instances included). */
export function inspectRouter<Meta = Record<string, unknown>>(
  router: object,
): RouteInfo<Meta>[] {
  const out: RouteInfo<Meta>[] = [];
  const walk = (node: RouterRecord, prefix: string[]): void => {
    for (const k of Object.keys(node)) {
      const child = node[k];
      if ((child as AnyProc)._dendra) {
        const proc = child as AnyProc;
        out.push({
          path: [...prefix, k].join("."),
          kind: proc.kind,
          method: proc.method,
          ...(proc.path ? { restPath: proc.path } : {}),
          middlewares: [...(proc.middlewareNames ?? [])],
          ai: proc.ai?.expose === true,
          confirm: proc.ai?.confirm === true,
          noAi: proc.noAi === true,
          meta: { ...proc.meta } as Meta,
        });
      } else {
        walk(child as RouterRecord, [...prefix, k]);
      }
    }
  };
  walk(router as RouterRecord, []);
  return out;
}
