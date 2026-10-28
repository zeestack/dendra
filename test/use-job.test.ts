import { describe, it, expect } from "vitest";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useJob } from "../src/react.ts";
import type { FollowedJob, JobSnapshotLike } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Snap = JobSnapshotLike & { id: string };

// A watch per job id, pushed to by hand.
function watches() {
  const open = new Map<string, { push: (s: Snap) => void; signal: AbortSignal }>();
  const watch = (id: string, signal: AbortSignal): AsyncIterable<Snap> => ({
    async *[Symbol.asyncIterator]() {
      const queue: Snap[] = [];
      let wake = () => {};
      open.set(id, {
        push: (s) => {
          queue.push(s);
          wake();
        },
        signal,
      });
      signal.addEventListener("abort", () => wake());
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        while (queue.length) yield queue.shift()!;
      }
    },
  });
  return { open, watch };
}

function render(jobId: string | null, watch: (id: string, s: AbortSignal) => AsyncIterable<Snap>) {
  const states: FollowedJob<Snap>[] = [];
  function Probe({ id }: { id: string | null }) {
    states.push(useJob(id, watch));
    return null;
  }
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(createElement(Probe, { id: jobId }));
  });
  return {
    states,
    last: () => states[states.length - 1],
    rerender: (id: string | null) => act(() => r.update(createElement(Probe, { id }))),
    unmount: () => act(() => r.unmount()),
  };
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 5)));

describe("useJob", () => {
  it("is idle without an id", () => {
    const { last } = render(null, watches().watch);
    expect(last()).toEqual({ job: null, connection: "idle", error: null });
  });

  it("follows the job until it settles", async () => {
    const { open, watch } = watches();
    const { last } = render("a", watch);
    expect(last().connection).toBe("connecting");
    await flush();
    await act(async () => open.get("a")!.push({ id: "a", version: 1, status: "running" }));
    await flush();
    expect(last()).toMatchObject({ job: { version: 1, status: "running" }, connection: "live" });
    await act(async () => open.get("a")!.push({ id: "a", version: 2, status: "succeeded" }));
    await flush();
    expect(last()).toMatchObject({ job: { status: "succeeded" }, connection: "ended" });
  });

  it("aborts the watch on unmount", async () => {
    const { open, watch } = watches();
    const { unmount } = render("a", watch);
    await flush();
    unmount();
    expect(open.get("a")!.signal.aborted).toBe(true);
  });

  it("switches jobs without showing the old one's state", async () => {
    const { open, watch } = watches();
    const { last, rerender, states } = render("a", watch);
    await flush();
    await act(async () => open.get("a")!.push({ id: "a", version: 5, status: "running" }));
    await flush();
    const before = states.length;
    rerender("b");
    expect(open.get("a")!.signal.aborted).toBe(true);
    expect(states.slice(before).every((st) => st.job?.id !== "a")).toBe(true);
    await flush();
    await act(async () => open.get("b")!.push({ id: "b", version: 1, status: "queued" }));
    await flush();
    expect(last().job).toMatchObject({ id: "b", status: "queued" });
  });
});
