import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnCaptured } from "../src/transport/real.js";

describe("spawnCaptured", () => {
  it("captures small stdout and stderr", async () => {
    const result = await spawnCaptured("node", [
      "-e",
      "process.stdout.write('out\\n'); process.stderr.write('err\\n');",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "out\n");
    assert.equal(result.stderr.toString(), "err\n");
  });

  it("rejects when stdout exceeds maxBytes", async () => {
    const size = 2000;
    const maxBytes = 1000;
    const script = `process.stdout.write(Buffer.alloc(${size}).fill("x"));`;
    await assert.rejects(
      () => spawnCaptured("node", ["-e", script], { maxBytes, timeoutMs: 5000 }),
      /remote output exceeded/,
    );
  });

  it("rejects when stderr exceeds maxBytes", async () => {
    const size = 2000;
    const maxBytes = 1000;
    const script = `process.stderr.write(Buffer.alloc(${size}).fill("e"));`;
    await assert.rejects(
      () => spawnCaptured("node", ["-e", script], { maxBytes, timeoutMs: 5000 }),
      /remote stderr output exceeded/,
    );
  });
});
