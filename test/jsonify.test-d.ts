import { expectTypeOf } from "vitest";
import {
  initDendra,
  createCaller,
  createClient,
  createWsClient,
  file,
  s,
  type Caller,
  type Client,
  type Jsonify,
  type RouterRecord,
} from "../src/index.ts";

// --- Jsonify: the type a value has after JSON.stringify → JSON.parse ---------

// Dates (anything with toJSON) become what toJSON returns.
expectTypeOf<Jsonify<Date>>().toEqualTypeOf<string>();
expectTypeOf<Jsonify<{ toJSON(): { v: number } }>>().toEqualTypeOf<{ v: number }>();

// Primitives and literals pass through.
expectTypeOf<Jsonify<"a" | 1 | true | null>>().toEqualTypeOf<"a" | 1 | true | null>();

// Top-level undefined stays (an empty result arrives as undefined).
expectTypeOf<Jsonify<undefined>>().toEqualTypeOf<undefined>();
expectTypeOf<Jsonify<void>>().toEqualTypeOf<undefined>();

// Object props: undefined/function props are dropped, `T | undefined` goes optional.
type Row = {
  id: number;
  at: Date;
  note?: string;
  maybe: string | undefined;
  gone: undefined;
  fn: () => void;
  nested: { when: Date[] };
};
expectTypeOf<Jsonify<Row>>().toEqualTypeOf<{
  id: number;
  at: string;
  note?: string;
  maybe?: string;
  nested: { when: string[] };
}>();

// Arrays: undefined and functions become null; tuples keep their shape.
expectTypeOf<Jsonify<(string | undefined)[]>>().toEqualTypeOf<(string | null)[]>();
expectTypeOf<Jsonify<[Date, number]>>().toEqualTypeOf<[string, number]>();

// Records keep their index signature.
expectTypeOf<Jsonify<Record<string, Date>>>().toEqualTypeOf<{ [k: string]: string }>();

// Map and Set serialize as {}.
expectTypeOf<Jsonify<Map<string, number>>>().toEqualTypeOf<{}>();
expectTypeOf<Jsonify<Set<number>>>().toEqualTypeOf<{}>();

// Class instances lose their methods.
class Point {
  constructor(public x: number) {}
  len() {
    return this.x;
  }
}
expectTypeOf<Jsonify<Point>>().toEqualTypeOf<{ x: number }>();

// any / unknown aren't narrowed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
expectTypeOf<Jsonify<any>>().toBeAny();
expectTypeOf<Jsonify<unknown>>().toEqualTypeOf<unknown>();

// Recursive types still resolve.
type Tree = { at: Date; kids: Tree[] };
expectTypeOf<Jsonify<Tree>["kids"][number]["at"]>().toEqualTypeOf<string>();

// --- clients over the wire get JSON types; the in-process caller doesn't -----

const { route } = initDendra();
const router = {
  note: route.handler(() => ({ id: 1, createdAt: new Date() })),
  feed: route.stream(async function* () {
    yield { at: new Date() };
  }),
  nothing: route.handler(() => {}),
  download: route.get().handler(() => file("x", { type: "text/plain", filename: "x.txt" })),
} satisfies RouterRecord;
type R = typeof router;

const api = createClient<R>("");
expectTypeOf(api.note).returns.toEqualTypeOf<Promise<{ id: number; createdAt: string }>>();
expectTypeOf(api.feed).returns.toEqualTypeOf<AsyncIterable<{ at: string }>>();
expectTypeOf(api.nothing).returns.toEqualTypeOf<Promise<undefined>>();
expectTypeOf(api.download).returns.toEqualTypeOf<Promise<Blob>>();
expectTypeOf(api).toEqualTypeOf<Client<R>>();

const ws = createWsClient<R>(() => {});
expectTypeOf(ws.api.note).returns.toEqualTypeOf<Promise<{ id: number; createdAt: string }>>();

const caller = createCaller(router);
expectTypeOf(caller.note).returns.toEqualTypeOf<Promise<{ id: number; createdAt: Date }>>();
expectTypeOf(caller.feed).returns.toEqualTypeOf<AsyncIterable<{ at: Date }>>();
expectTypeOf(caller.download).returns.toEqualTypeOf<Promise<Blob>>();
expectTypeOf(caller).toEqualTypeOf<Caller<R>>();
