import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  combineStreams,
  controlPathFor,
  formatBytes,
  formatFailure,
  isStaleMuxError,
  parseTarget,
  remoteShellCommand,
  shellQuote,
  sshArgs,
} from "../src/util.js";

describe("parseTarget", () => {
  it("parses user@host", () => {
    assert.deepEqual(parseTarget("demo@127.0.0.1"), { userHost: "demo@127.0.0.1", port: undefined });
  });

  it("parses user@host:port", () => {
    assert.deepEqual(parseTarget("demo@127.0.0.1:2222"), { userHost: "demo@127.0.0.1", port: 2222 });
  });

  it("parses IPv6 bracket form", () => {
    assert.deepEqual(parseTarget("demo@[::1]:22"), { userHost: "demo@::1", port: 22 });
  });

  it("rejects missing user@", () => {
    assert.throws(() => parseTarget("localhost"), /user@host/);
  });

  it("rejects empty", () => {
    assert.throws(() => parseTarget("  "), /required/);
  });

  it("rejects invalid port", () => {
    assert.throws(() => parseTarget("a@b:99999"), /invalid SSH port/);
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    assert.equal(shellQuote("hello"), "'hello'");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  });
});

describe("remoteShellCommand", () => {
  it("uses non-login bash with quoted command", () => {
    const cmd = remoteShellCommand("echo hi");
    assert.match(cmd, /bash --noprofile --norc -c 'echo hi'/);
    assert.doesNotMatch(cmd, /bash -lc|sh -lc/);
  });
});

describe("sshArgs", () => {
  it("includes BatchMode, mux, and remote command after --", () => {
    const args = sshArgs("demo@host:2222", "true", "/tmp/mux");
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("2222"));
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "true");
    assert.equal(args.at(-3), "demo@host");
  });

  it("derives stable control path", () => {
    const a = controlPathFor("demo@host", "/tmp/mux");
    const b = controlPathFor("demo@host:22", "/tmp/mux");
    assert.equal(a, b);
    assert.match(a, /\/tmp\/mux\/[0-9a-f]{24}$/);
  });
});

describe("helpers", () => {
  it("detects stale mux errors", () => {
    assert.equal(isStaleMuxError("Control socket connect failed"), true);
    assert.equal(isStaleMuxError("permission denied"), false);
  });

  it("formats failure with stderr preference", () => {
    const msg = formatFailure({
      code: 2,
      stdout: Buffer.from("out\n"),
      stderr: Buffer.from("err\n"),
    });
    assert.match(msg, /code 2/);
    assert.match(msg, /err/);
    assert.match(msg, /out/);
  });

  it("combineStreams puts stderr in a labeled block", () => {
    assert.equal(combineStreams("hi\n", ""), "hi\n");
    assert.equal(combineStreams("hi", "boom"), "hi\n[stderr]\nboom\n");
  });

  it("formatBytes", () => {
    assert.equal(formatBytes(100), "100 B");
    assert.equal(formatBytes(2048), "2.0 KiB");
  });
});
