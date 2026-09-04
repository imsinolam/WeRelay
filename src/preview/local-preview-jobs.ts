import crypto from "node:crypto";

import {
  createLocalPreviewPackage,
  EphemeralLocalPreviewStore,
  LocalPreviewError,
  type LocalPreviewPackage,
} from "./local-preview.ts";

const DEFAULT_JOB_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_JOBS = 32;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;

export type LocalPreviewJobStatus = "queued" | "capturing" | "ready" | "failed";

export type LocalPreviewJobSnapshot = {
  jobId: string;
  status: LocalPreviewJobStatus;
  progress: number;
  message: string;
  createdAtMs: number;
  updatedAtMs: number;
  deploymentId?: string;
  entryPath?: string;
  readyUrl?: string;
  error?: string;
  previewPackage?: LocalPreviewPackage;
};

type StoredJob = LocalPreviewJobSnapshot & {
  target: string;
  previewPackage?: LocalPreviewPackage;
};

export type LocalPreviewJobManagerOptions = {
  workspaceRoot: string;
  store: EphemeralLocalPreviewStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  maxJobs?: number;
  maxConcurrentJobs?: number;
};

export class LocalPreviewJobManager {
  private readonly workspaceRoot: string;
  private readonly store: EphemeralLocalPreviewStore;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly maxConcurrentJobs: number;
  private readonly jobs = new Map<string, StoredJob>();
  private readonly queuedJobIds: string[] = [];
  private activeJobs = 0;

  constructor(options: LocalPreviewJobManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_JOB_TTL_MS;
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.maxConcurrentJobs = Math.max(
      1,
      options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
    );
  }

  create(target: string): LocalPreviewJobSnapshot {
    this.clean();
    const nowMs = this.now();
    const job: StoredJob = {
      jobId: `preview-job-${crypto.randomUUID()}`,
      target,
      status: "queued",
      progress: 4,
      message: "正在请求电脑准备最新内容",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.jobs.set(job.jobId, job);
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.jobs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.jobs.delete(oldest);
    }
    this.queuedJobIds.push(job.jobId);
    this.drainQueue();
    return this.snapshot(job, false);
  }

  read(
    jobId: string,
    options: { includePackage?: boolean } = {},
  ): LocalPreviewJobSnapshot | null {
    this.clean();
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return this.snapshot(job, options.includePackage === true);
  }

  private drainQueue(): void {
    while (this.activeJobs < this.maxConcurrentJobs && this.queuedJobIds.length > 0) {
      const jobId = this.queuedJobIds.shift();
      const job = jobId ? this.jobs.get(jobId) : undefined;
      if (!job || job.status !== "queued") continue;
      this.activeJobs += 1;
      void this.run(job).finally(() => {
        this.activeJobs -= 1;
        this.drainQueue();
      });
    }
  }

  private async run(job: StoredJob): Promise<void> {
    try {
      this.update(job, {
        status: "capturing",
        progress: 10,
        message: "正在读取本地页面和资源",
      });
      const deployment = await createLocalPreviewPackage(job.target, {
        workspaceRoot: this.workspaceRoot,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        now: this.now,
        onProgress: (progress) => {
          this.update(job, {
            status: "capturing",
            progress: progress.progress,
            message: progress.message,
          });
        },
      });
      this.store.put(deployment);
      this.update(job, {
        status: "ready",
        progress: 100,
        message: "部署完成，正在打开最新页面",
        deploymentId: deployment.deploymentId,
        entryPath: deployment.entryPath,
        readyUrl: `/preview/view/${encodeURIComponent(deployment.deploymentId)}`,
        previewPackage: deployment,
      });
    } catch (error) {
      const message = error instanceof LocalPreviewError || error instanceof Error
        ? error.message
        : "手机预览部署失败，请重试。";
      this.update(job, {
        status: "failed",
        progress: 100,
        message: "部署没有完成",
        error: message,
      });
    }
  }

  private update(job: StoredJob, patch: Partial<StoredJob>): void {
    Object.assign(job, patch, { updatedAtMs: this.now() });
  }

  private snapshot(job: StoredJob, includePackage: boolean): LocalPreviewJobSnapshot {
    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      message: job.message,
      createdAtMs: job.createdAtMs,
      updatedAtMs: job.updatedAtMs,
      ...(job.deploymentId ? { deploymentId: job.deploymentId } : {}),
      ...(job.entryPath ? { entryPath: job.entryPath } : {}),
      ...(job.readyUrl ? { readyUrl: job.readyUrl } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(includePackage && job.previewPackage
        ? { previewPackage: job.previewPackage }
        : {}),
    };
  }

  private clean(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [jobId, job] of this.jobs) {
      if (job.updatedAtMs < cutoff) this.jobs.delete(jobId);
    }
  }
}
