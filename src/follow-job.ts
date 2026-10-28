// Follow a background job from the client. `job.watch(id)` on the server sends
// the job's state now, then each change, ending at "succeeded" or "failed".
// `followJob` keeps that subscription going until the job settles: when the
// stream drops (network error, `UNAVAILABLE`, or an end before a final state)
// it opens it again after a backoff — and since a fresh watch starts with the
// current state, nothing is missed. Versions drop anything already seen.
//
//   const f = followJob((signal) => api.jobs.watch({ jobId }, { signal }));
//   f.subscribe(({ job }) => render(job));
//   const final = await f.done;   // the succeeded/failed snapshot
//
// Framework-agnostic; `useJob` in `dendra/react` is a thin hook over it.

/** The part of a job snapshot `followJob` reads. */
export interface JobSnapshotLike {
  status: string;
  version: number;
}

export type JobConnection =
  /** No job to follow (`useJob` without an id). */
  | "idle"
  /** Opening the first watch. */
  | "connecting"
  /** Updates are arriving. */
  | "live"
  /** The watch dropped; trying again after a backoff. */
  | "reconnecting"
  /** Stopped: the job settled, `stop()` was called, or `error` is set. */
  | "ended";

export interface FollowedJob<S> {
  /** The latest snapshot, or `null` before the first arrives. */
  job: S | null;
  connection: JobConnection;
  /**
   * Why following stopped before the job settled — e.g. `NOT_FOUND` or
   * `UNAUTHORIZED` from the watch procedure. A job that ran and failed is
   * `job.status === "failed"` with `job.error`, not this.
   */
  error: (Error & { code?: string }) | null;
}

export interface JobFollower<S> {
  get(): FollowedJob<S>;
  /** Called on every change; returns an unsubscribe. */
  subscribe(listener: (state: FollowedJob<S>) => void): () => void;
  /** Stop following and abort the open watch. */
  stop(): void;
  /**
   * The succeeded or failed snapshot. Rejects with `error` if following stops
   * first, or with an `AbortError` after `stop()`.
   */
  done: Promise<S>;
}

export interface FollowJobOptions {
  /** Aborting it is the same as `stop()`. */
  signal?: AbortSignal;
  /** Reconnect delay: starts at `initialMs`, doubles up to `maxMs`, ±25% jitter. Default 500 ms → 10 s. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Where to hear "online" to retry at once. Default `globalThis` in browsers; `false` turns it off. */
  online?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | false;
}

const isFinal = (status: string) => status === "succeeded" || status === "failed";

// A coded error (NOT_FOUND, UNAUTHORIZED, …) won't go away by asking again —
// except UNAVAILABLE, which is how a WebSocket connection reports a drop.
// Anything without a code (a network TypeError, a proxy's HTML) is transient.
// Checked by shape, not `instanceof`, so it holds across bundled copies.
function isFatal(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "UNAVAILABLE";
}

export function followJob<S extends JobSnapshotLike>(
  open: (signal: AbortSignal) => AsyncIterable<S>,
  opts: FollowJobOptions = {},
): JobFollower<S> {
  const initialMs = opts.backoff?.initialMs ?? 500;
  const maxMs = opts.backoff?.maxMs ?? 10_000;
  const g = globalThis as { addEventListener?: unknown };
  const online =
    opts.online === false
      ? undefined
      : (opts.online ?? (typeof g.addEventListener === "function" ? (globalThis as unknown as EventTarget) : undefined));
  const ac = new AbortController();
  const listeners = new Set<(s: FollowedJob<S>) => void>();
  let state: FollowedJob<S> = { job: null, connection: "connecting", error: null };
  const set = (patch: Partial<FollowedJob<S>>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  let settle!: [(s: S) => void, (e: unknown) => void];
  const done = new Promise<S>((resolve, reject) => (settle = [resolve, reject]));
  // A follower nobody awaits mustn't raise an unhandled rejection.
  done.catch(() => {});

  const stop = () => ac.abort(new DOMException("Stopped following the job", "AbortError"));
  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener("abort", stop, { once: true });

  // A backoff wait ends early on stop, or when the browser comes back online.
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      ac.signal.addEventListener("abort", done, { once: true });
      online?.addEventListener("online", done);
      function done() {
        clearTimeout(t);
        ac.signal.removeEventListener("abort", done);
        online?.removeEventListener("online", done);
        resolve();
      }
    });

  void (async () => {
    let attempt = 0;
    while (!ac.signal.aborted) {
      try {
        for await (const snap of open(ac.signal)) {
          if (ac.signal.aborted) break;
          attempt = 0;
          if (state.job && snap.version <= state.job.version) {
            if (state.connection !== "live") set({ connection: "live" });
            continue;
          }
          set({ job: snap, connection: "live" });
          if (isFinal(snap.status)) {
            set({ connection: "ended" });
            settle[0](snap);
            return;
          }
        }
      } catch (e) {
        if (ac.signal.aborted) break;
        if (isFatal(e)) {
          set({ connection: "ended", error: e as FollowedJob<S>["error"] });
          settle[1](e);
          return;
        }
      }
      if (ac.signal.aborted) break;
      set({ connection: "reconnecting" });
      const base = Math.min(maxMs, initialMs * 2 ** attempt++);
      await wait(base * (0.75 + Math.random() * 0.5));
    }
    opts.signal?.removeEventListener("abort", stop);
    if (state.connection !== "ended") set({ connection: "ended" });
    settle[1](ac.signal.reason);
  })();

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop,
    done,
  };
}
