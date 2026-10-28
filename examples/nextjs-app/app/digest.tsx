"use client";

// Starts a background job and follows it with `useJob`: the job's status and
// progress arrive over the digestStatus subscription as they change, with no
// polling. If the stream drops, useJob reopens it and picks up the current state.

import { useState } from "react";
import { useJob } from "dendra/react";
import { api } from "@/lib/api";
import u from "./ui.module.css";

export function Digest() {
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, connection, error } = useJob(jobId, (id, signal) =>
    api.notes.digestStatus({ jobId: id }, { signal }),
  );
  const running = jobId !== null && !error && job?.status !== "succeeded" && job?.status !== "failed";

  async function start() {
    const { jobId } = await api.notes.digest();
    setJobId(jobId);
  }

  const progress = job?.progress as { done: number; total: number } | null | undefined;
  let status = "";
  if (error) status = `Couldn't follow the job: ${error.message}`;
  else if (job?.status === "succeeded") status = `${job.result.notes} notes, ${job.result.words} words.`;
  else if (job?.status === "failed") status = `Failed: ${job.error.message}`;
  else if (job?.status === "running" && progress) status = `Counting… ${progress.done} of ${progress.total}`;
  else if (jobId) status = connection === "reconnecting" ? "Reconnecting…" : "Queued…";

  return (
    <div className={u.formRow}>
      <button onClick={start} disabled={running} className={u.btn}>
        Count words
      </button>
      <span className={u.muted}>{status}</span>
    </div>
  );
}
