/**
 * In-memory async media job store (video generations, etc.).
 * Hosts poll GET /v1/kgm/media/jobs/:id until completed|failed.
 * Jobs are scoped by owner_key_id (virtual/master key id); anonymous shares "anonymous".
 */

import { generateId } from "../utils/id.js";

export type MediaJobStatus = "queued" | "processing" | "completed" | "failed";

export type MediaJob = {
  id: string;
  object: "kgm.media_job";
  kind: "video";
  status: MediaJobStatus;
  created_at: number;
  updated_at: number;
  model?: string;
  /** Owning auth keyId (master | virtual id | anonymous). */
  owner_key_id?: string;
  /** Full create request — redacted in public views for non-master callers. */
  request?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
  upstream_job_id?: string;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_JOBS = 200;

export class MediaJobStore {
  private jobs = new Map<string, MediaJob>();
  private ttlMs: number;
  private maxJobs: number;
  private inFlight = 0;

  constructor(options?: { ttlMs?: number; maxJobs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxJobs = options?.maxJobs ?? DEFAULT_MAX_JOBS;
  }

  create(partial: Pick<MediaJob, "kind"> & Partial<MediaJob>): MediaJob {
    this.sweep();
    while (this.jobs.size >= this.maxJobs) {
      const oldest = [...this.jobs.values()].sort((a, b) => a.created_at - b.created_at)[0];
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    const now = Math.floor(Date.now() / 1000);
    const job: MediaJob = {
      id: `mediajob_${generateId()}`,
      object: "kgm.media_job",
      kind: partial.kind,
      status: "queued",
      created_at: now,
      updated_at: now,
      model: partial.model,
      owner_key_id: partial.owner_key_id ?? "anonymous",
      request: partial.request,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  get(id: string): MediaJob | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  /**
   * Fetch job if caller may see it.
   * - master: all jobs
   * - virtual/anonymous: only matching owner_key_id
   * Non-master views redact request body (prompt leakage).
   */
  getForCaller(
    id: string,
    auth: { kind: string; keyId: string },
  ): MediaJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    if (auth.kind === "master") {
      return job;
    }
    const owner = job.owner_key_id ?? "anonymous";
    if (owner !== auth.keyId) {
      return undefined;
    }
    return redactJobForCaller(job);
  }

  update(id: string, patch: Partial<MediaJob>): MediaJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch, { updated_at: Math.floor(Date.now() / 1000) });
    this.jobs.set(id, job);
    return { ...job };
  }

  /** Try to acquire a concurrency slot; returns false if at limit. */
  tryAcquireSlot(maxConcurrent: number): boolean {
    if (this.inFlight >= maxConcurrent) return false;
    this.inFlight += 1;
    return true;
  }

  releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (job.updated_at * 1000 < cutoff) this.jobs.delete(id);
    }
  }
}

export function redactJobForCaller(job: MediaJob): MediaJob {
  const { request, ...rest } = job;
  return {
    ...rest,
    request: request
      ? {
          model: typeof request.model === "string" ? request.model : undefined,
          // intentionally omit prompt / media blobs
        }
      : undefined,
  };
}

let singleton: MediaJobStore | undefined;

export function getMediaJobStore(): MediaJobStore {
  if (!singleton) singleton = new MediaJobStore();
  return singleton;
}

/** Test helper */
export function resetMediaJobStoreForTests(): void {
  singleton = new MediaJobStore();
}
