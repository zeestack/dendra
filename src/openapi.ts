// OpenAPI 3.1 emission — the cross-language / cross-repo escape hatch. We already
// hold every input JSON Schema (and output schema when `.output()` is declared),
// so the spec is a pure derivation: no extra annotation, no codegen. Feed the
// result to Swagger UI for docs, or to `openapi-typescript` / `openapi-generator`
// to produce clients in other languages. Only procedures with a REST `path` are
// included (RPC-only procedures stay out of the REST surface).

import type { AnyProc, RouterRecord } from "./core.ts";
import type { JSONSchema } from "./schema.ts";
import { FILE_MARKER, fileFields } from "./files.ts";

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiOptions {
  info: OpenApiInfo;
  servers?: Array<{ url: string; description?: string }>;
}

export function toOpenApiDocument(
  router: object,
  opts: OpenApiOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  const walk = (node: RouterRecord, prefix: string[]): void => {
    for (const k of Object.keys(node)) {
      const child = node[k];
      if ((child as AnyProc)._dendra) {
        const proc = child as AnyProc;
        if (!proc.path) continue;
        const oaPath = proc.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        const method = proc.method.toLowerCase();
        (paths[oaPath] ??= {})[method] = buildOperation(
          proc,
          [...prefix, k].join("."),
        );
      } else {
        walk(child as RouterRecord, [...prefix, k]);
      }
    }
  };
  walk(router as RouterRecord, []);

  return {
    openapi: "3.1.0",
    info: opts.info,
    ...(opts.servers ? { servers: opts.servers } : {}),
    paths,
  };
}

// Uploads are documented as plain OpenAPI binary fields; dendra's internal
// file marker stays out of the published spec.
function withoutFileMarkers(schema: JSONSchema, files: string[]): JSONSchema {
  const properties = { ...schema.properties };
  for (const k of files) {
    const { [FILE_MARKER]: _marker, ...rest } = properties[k] as JSONSchema;
    properties[k] = rest;
  }
  return { ...schema, properties };
}

function buildOperation(proc: AnyProc, operationId: string): Record<string, unknown> {
  const pathParams = (proc.path?.match(/:([A-Za-z0-9_]+)/g) ?? []).map((s) =>
    s.slice(1),
  );
  const props = proc.inputJsonSchema?.properties ?? {};
  const required = new Set(proc.inputJsonSchema?.required ?? []);
  const isGet = proc.method === "GET";

  const parameters: Array<Record<string, unknown>> = pathParams.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));

  if (isGet) {
    for (const [name, schema] of Object.entries(props)) {
      if (pathParams.includes(name)) continue;
      parameters.push({
        name,
        in: "query",
        required: required.has(name),
        schema: schema as JSONSchema,
      });
    }
  }

  const op: Record<string, unknown> = {
    operationId,
    summary: proc.description ?? operationId,
    tags: [operationId.split(".")[0]],
    parameters,
    responses: {
      "200": {
        description: "Success",
        content: {
          "application/json": { schema: proc.outputJsonSchema ?? {} },
        },
      },
      "400": { description: "Validation error" },
    },
  };

  if (!isGet && proc.inputJsonSchema) {
    const files = fileFields(proc.inputJsonSchema);
    op.requestBody = {
      required: true,
      content:
        files.length > 0
          ? { "multipart/form-data": { schema: withoutFileMarkers(proc.inputJsonSchema, files) } }
          : { "application/json": { schema: proc.inputJsonSchema } },
    };
  }
  if (proc.kind === "stream") op["x-dendra-streaming"] = true;

  return op;
}
