import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeUtf8 } from "./util.js";

export const JOB_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const JOB_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JOB_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "mcp-ssh-agentic",
  "jobs",
);

const DEFAULT_TRUNCATE_MARKER = "[... earlier output truncated; only the last ~5 MiB is retained ...]\n";

/**
 * Bounded in-memory log writer that keeps the most recent bytes and flushes to disk on demand.
 */
export class RotatingFileWriter {
  /**
   * @param {string} filePath
   * @param {number} [maxBytes]
   * @param {string} [marker]
   */
  constructor(filePath, maxBytes = JOB_LOG_MAX_BYTES, marker = DEFAULT_TRUNCATE_MARKER) {
    this.path = filePath;
    this.maxBytes = maxBytes;
    this.marker = Buffer.from(marker);
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this._flushing = Promise.resolve();
  }

  /** @param {Buffer|string} chunk */
  write(chunk) {
    if (this.ended) return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.buf = Buffer.concat([this.buf, b]);
    if (this.buf.length > this.maxBytes) {
      const keep = Math.max(0, this.maxBytes - this.marker.length);
      const tail = keep > 0 ? this.buf.slice(-keep) : Buffer.alloc(0);
      this.buf = keep > 0 ? Buffer.concat([this.marker, tail]) : this.marker;
    }
  }

  /** Flush current buffer to disk. */
  async flush() {
    const snapshot = this.buf;
    this._flushing = this._flushing.then(async () => {
      await writeFile(this.path, snapshot);
    });
    await this._flushing;
  }

  /** Flush and mark writer as closed. */
  async end() {
    if (this.ended) return this._flushing;
    this.ended = true;
    await this.flush();
  }
}

/**
 * Manage background ssh_exec jobs: local logs, status, TTL cleanup, kill.
 *
 * @param {object} opts
 * @param {string} [opts.jobDir]
 * @param {number} [opts.logMaxBytes]
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.now]
 */
export function createJobManager({
  jobDir = DEFAULT_JOB_DIR,
  logMaxBytes = JOB_LOG_MAX_BYTES,
  ttlMs = JOB_TTL_MS,
  now = () => Date.now(),
} = {}) {
  mkdirSync(jobDir, { recursive: true });

  const jobs = new Map();

  function dir(id) { return join(jobDir, id); }
  function metaPath(id) { return join(dir(id), "meta.json"); }
  function stdoutPath(id) { return join(dir(id), "stdout.log"); }
  function stderrPath(id) { return join(dir(id), "stderr.log"); }

  function writeMetaSync(id, meta) {
    mkdirSync(dir(id), { recursive: true });
    writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  }

  function cleanupOldJobs() {
    const cutoff = now() - ttlMs;
    for (const name of readdirSync(jobDir)) {
      const d = join(jobDir, name);
      try {
        const st = statSync(d);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          rmSync(d, { recursive: true, force: true });
        }
      } catch {
        // ignore directories we cannot stat/remove
      }
    }
  }

  cleanupOldJobs();

  /**
   * Start tracking a background job.
   * @param {object} opts
   * @param {string} opts.target
   * @param {string} opts.command
   * @param {string} [opts.cwd]
   * @param {Record<string,string>} [opts.env]
   * @param {import('node:child_process').ChildProcess} opts.child
   * @returns {{ id: string }}
   */
  async function start({ target, command, cwd, env, child }) {
    const id = randomUUID();
    const dirPath = dir(id);

    if (!child || !child.pid) {
      throw new Error("failed to spawn background process");
    }

    const stdoutWriter = new RotatingFileWriter(stdoutPath(id), logMaxBytes);
    const stderrWriter = new RotatingFileWriter(stderrPath(id), logMaxBytes);

    // Attach listeners before any I/O so we do not miss fast output.
    child.stdout?.on("data", (chunk) => stdoutWriter.write(chunk));
    child.stderr?.on("data", (chunk) => stderrWriter.write(chunk));
    child.on("exit", async (code, signal) => {
      meta.status = "exited";
      meta.exitCode = code ?? (signal ? 1 : 0);
      meta.signal = signal || null;
      meta.endTime = now();
      await stdoutWriter.end();
      await stderrWriter.end();
      writeMetaSync(id, meta);
      jobs.delete(id);
    });
    child.on("error", async (error) => {
      meta.status = "error";
      meta.error = error.message;
      meta.endTime = now();
      await stdoutWriter.end();
      await stderrWriter.end();
      writeMetaSync(id, meta);
      jobs.delete(id);
    });

    const meta = {
      id,
      target,
      command,
      cwd,
      env,
      status: "running",
      startTime: now(),
      pid: child.pid,
    };
    mkdirSync(dirPath, { recursive: true });
    writeMetaSync(id, meta);

    const job = { id, child, stdoutWriter, stderrWriter, meta };
    jobs.set(id, job);
    return job;
  }

  function readMeta(id) {
    try {
      return JSON.parse(readFileSync(metaPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  function getInMemory(id) {
    return jobs.get(id) || null;
  }

  function isChildRunning(child) {
    if (!child || child.killed) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} id
   * @returns {{ id: string, meta: object, child?: import('node:child_process').ChildProcess, stdoutWriter?: RotatingFileWriter, stderrWriter?: RotatingFileWriter } | null}
   */
  function getJob(id) {
    const mem = getInMemory(id);
    if (mem) return mem;
    if (!existsSync(metaPath(id))) return null;
    const meta = readMeta(id);
    if (!meta) return null;
    return { id, meta };
  }

  /**
   * Return current job status and output.
   * @param {string} id
   * @param {{ wait?: boolean, timeoutMs?: number }} [opts]
   */
  async function getResult(id, { wait = false, timeoutMs = 10000 } = {}) {
    let job = getJob(id);
    if (!job) return null;

    if (wait && job.child) {
      const deadline = now() + timeoutMs;
      while (isChildRunning(job.child) && now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // flush any buffered output before reading
    await job.stdoutWriter?.flush();
    await job.stderrWriter?.flush();

    // re-read meta in case child just exited and updated it
    const meta = job.meta || readMeta(id) || {};
    const status = (() => {
      if (meta.status && meta.status !== "running") return meta.status;
      if (job.child) return isChildRunning(job.child) ? "running" : "exited";
      return "unknown";
    })();

    const stdout = existsSync(stdoutPath(id)) ? decodeUtf8(await readFile(stdoutPath(id))) : "";
    const stderr = existsSync(stderrPath(id)) ? decodeUtf8(await readFile(stderrPath(id))) : "";

    return {
      ...meta,
      status,
      stdout,
      stderr,
      timedOut: wait && status === "running" && now() >= (meta.startTime || 0) + timeoutMs,
    };
  }

  /**
   * Send a signal to a running background job and optionally clean up its logs.
   * @param {string} id
   * @param {string} [signal]
   * @param {boolean} [cleanup]
   */
  async function kill(id, signal = "SIGTERM", cleanup = false) {
    signal = signal || "SIGTERM";
    const job = getJob(id);
    if (!job) return { found: false, killed: false, cleaned: false };

    let killed = false;
    if (job.child && isChildRunning(job.child)) {
      try {
        if (process.platform !== "win32" && job.child.pid) {
          process.kill(-job.child.pid, signal);
        } else {
          job.child.kill(signal);
        }
        killed = true;
      } catch {
        try {
          job.child.kill(signal);
          killed = true;
        } catch {
          killed = false;
        }
      }
    }

    if (cleanup) {
      try {
        rmSync(dir(id), { recursive: true, force: true });
      } catch {
        // ignore
      }
      jobs.delete(id);
      return { found: true, killed, cleaned: true };
    }

    return { found: true, killed, cleaned: false };
  }

  function killAll(signal = "SIGTERM") {
    for (const job of jobs.values()) {
      kill(job.id, signal, false).catch(() => {});
    }
  }

  return {
    jobDir,
    start,
    getJob,
    getResult,
    kill,
    killAll,
    cleanupOldJobs,
  };
}
