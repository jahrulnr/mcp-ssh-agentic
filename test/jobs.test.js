import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { createJobManager, RotatingFileWriter, JOB_TTL_MS } from "../src/jobs.js";

describe("RotatingFileWriter", () => {
  it("writes content to a file and flushes on end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-jobs-writer-"));
    const path = join(dir, "out.log");
    const writer = new RotatingFileWriter(path, 1024);
    writer.write("hello\n");
    writer.write("world\n");
    await writer.end();

    const fs = await import("node:fs/promises");
    const data = await fs.readFile(path, "utf8");
    assert.equal(data, "hello\nworld\n");
  });

  it("truncates from the head and adds a marker when max bytes is exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-jobs-truncate-"));
    const path = join(dir, "out.log");
    const marker = "[TRUNCATED]\n";
    const writer = new RotatingFileWriter(path, 50, marker);
    const oldPrefix = "AAAA".repeat(10) + "\n";
    writer.write(oldPrefix);
    writer.write("BBBB".repeat(10) + "\n");
    writer.write("CCCC".repeat(10) + "\n");
    await writer.end();

    const fs = await import("node:fs/promises");
    const data = await fs.readFile(path, "utf8");
    assert.ok(data.startsWith(marker));
    assert.ok(!data.includes(oldPrefix.trim()));
    assert.ok(data.length <= 50);
  });
});

describe("createJobManager", () => {
  let jobDir;

  before(() => {
    jobDir = mkdtempSync(join(tmpdir(), "mcp-jobs-mgr-"));
  });

  it("cleans up job directories older than the TTL on creation", () => {
    const oldDir = join(jobDir, "old-job");
    const freshDir = join(jobDir, "fresh-job");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(oldDir, "meta.json"), "{}");
    writeFileSync(join(freshDir, "meta.json"), "{}");

    const now = Date.now();
    const oldTime = new Date(now - JOB_TTL_MS - 1000);
    utimesSync(oldDir, oldTime, oldTime);

    createJobManager({ jobDir });

    assert.equal(existsSync(oldDir), false);
    assert.ok(existsSync(freshDir));
  });

  it("starts, waits for, and retrieves output from a detached job", async () => {
    const mgr = createJobManager({ jobDir });
    const child = spawn("bash", ["--noprofile", "--norc", "-c", "echo 'job output'; sleep 0.05"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const { id } = await mgr.start({ target: "u@h", command: "echo 'job output'", child });
    const result = await mgr.getResult(id, { wait: true, timeoutMs: 5000 });
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /job output/);
  });
});
