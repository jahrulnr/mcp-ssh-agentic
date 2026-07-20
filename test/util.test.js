import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  combineStreams,
  controlPathFor,
  describeLocalClient,
  formatBytes,
  formatFailure,
  isMuxUnsupportedError,
  isStaleMuxError,
  muxOptions,
  parseTarget,
  remoteApplyPatchCommand,
  remoteGrepCommand,
  remoteListDirCommand,
  remoteReadFileCommand,
  remoteShellCommand,
  resolveMuxEnabled,
  scpRemoteSpec,
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
  it("uses non-login bash with -- separator and quoted command", () => {
    const cmd = remoteShellCommand("echo hi");
    assert.match(cmd, /bash --noprofile --norc -c -- 'echo hi'/);
    assert.doesNotMatch(cmd, /bash -lc|sh -lc/);
  });

  it("does not treat leading dash commands as bash options", () => {
    const cmd = remoteShellCommand("-n");
    assert.match(cmd, /bash --noprofile --norc -c -- '-n'/);
  });
});

describe("remoteListDirCommand", () => {
  it("uses ls -lAh for metadata-rich listing", () => {
    const cmd = remoteListDirCommand("/tmp/listed");
    assert.match(cmd, /LC_ALL=C ls -lAh --/);
    assert.match(cmd, /\/tmp\/listed/);
  });
});

describe("remoteReadFileCommand", () => {
  it("reads whole file by default", () => {
    assert.match(remoteReadFileCommand("/tmp/x"), /cat -- '\/tmp\/x'/);
  });

  it("limits line count from the start", () => {
    assert.match(remoteReadFileCommand("/tmp/x", 1, 50), /head -n 50/);
  });

  it("starts from an offset", () => {
    assert.match(remoteReadFileCommand("/tmp/x", 10, 0), /tail -n \+10/);
  });

  it("combines offset and limit", () => {
    const cmd = remoteReadFileCommand("/tmp/x", 5, 20);
    assert.match(cmd, /tail -n \+5 \| head -n 20/);
  });

  it("treats offset 0 as 1", () => {
    assert.match(remoteReadFileCommand("/tmp/x", 0, 10), /head -n 10/);
  });
});

describe("remoteGrepCommand", () => {
  it("prefers rg and formats file:line:match", () => {
    const cmd = remoteGrepCommand({ pattern: "TODO", path: "/src" });
    assert.match(cmd, /rg --no-heading -n --hidden --no-messages --/);
    assert.match(cmd, /TODO/);
    assert.match(cmd, /\/src/);
  });

  it("adds ripgrep option flags", () => {
    const cmd = remoteGrepCommand({
      pattern: "foo",
      path: "/src",
      glob: "*.js",
      ignoreCase: true,
      fixedStrings: true,
      wordRegexp: true,
      invert: true,
      maxResults: 10,
    });
    assert.match(cmd, /--glob '\*\.js'/);
    assert.match(cmd, /-i -F -w -v -m 10/);
  });

  it("falls back to grep", () => {
    const cmd = remoteGrepCommand({ pattern: "TODO", path: "/src", glob: "*.js", ignoreCase: true });
    assert.match(cmd, /grep -RIn/);
    assert.match(cmd, /--include='\*\.js'/);
    assert.match(cmd, /-i/);
  });
});

describe("remoteApplyPatchCommand", () => {
  it("includes apply_patch and patch -p0 for strip=0", () => {
    const cmd = remoteApplyPatchCommand();
    assert.match(cmd, /apply_patch/);
    assert.match(cmd, /patch -p0/);
  });

  it("supports strip level", () => {
    const cmd = remoteApplyPatchCommand({ strip: 1 });
    assert.match(cmd, /git apply -p1/);
    assert.doesNotMatch(cmd, /apply_patch/);
  });

  it("supports dry-run", () => {
    const cmd = remoteApplyPatchCommand({ dry_run: true });
    assert.match(cmd, /git apply --check/);
  });
});

describe("resolveMuxEnabled", () => {
  it("disables mux on win32 by default (cmd / PowerShell / Git Bash)", () => {
    assert.equal(resolveMuxEnabled({ platform: "win32", env: {} }), false);
  });

  it("enables mux on linux and darwin by default", () => {
    assert.equal(resolveMuxEnabled({ platform: "linux", env: {} }), true);
    assert.equal(resolveMuxEnabled({ platform: "darwin", env: {} }), true);
  });

  it("honors MCP_SSH_AGENTIC_MUX override", () => {
    assert.equal(resolveMuxEnabled({ platform: "win32", env: { MCP_SSH_AGENTIC_MUX: "1" } }), true);
    assert.equal(resolveMuxEnabled({ platform: "linux", env: { MCP_SSH_AGENTIC_MUX: "0" } }), false);
    assert.equal(resolveMuxEnabled({ platform: "win32", env: { MCP_SSH_AGENTIC_MUX: "yes" } }), true);
    assert.equal(resolveMuxEnabled({ platform: "darwin", env: { MCP_SSH_AGENTIC_MUX: "off" } }), false);
  });
});

describe("describeLocalClient", () => {
  it("labels unix platforms", () => {
    assert.equal(describeLocalClient({ platform: "linux", env: {} }), "linux");
    assert.equal(describeLocalClient({ platform: "darwin", env: {} }), "darwin");
  });

  it("distinguishes common Windows shells when env hints exist", () => {
    assert.equal(describeLocalClient({ platform: "win32", env: { MSYSTEM: "MINGW64" } }), "windows-git-bash");
    assert.equal(describeLocalClient({
      platform: "win32",
      env: { POWERSHELL_DISTRIBUTION_CHANNEL: "Windows Store" },
    }), "windows-powershell");
    assert.equal(describeLocalClient({ platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } }), "windows-cmd");
    assert.equal(describeLocalClient({ platform: "win32", env: {} }), "windows");
  });
});

describe("scpRemoteSpec", () => {
  it("builds a plain host:path spec", () => {
    assert.equal(scpRemoteSpec("demo@host", "/tmp/file"), "demo@host:/tmp/file");
  });

  it("brackets IPv6 hosts for scp", () => {
    assert.equal(scpRemoteSpec("demo@::1", "/tmp/file"), "demo@[::1]:/tmp/file");
    assert.equal(scpRemoteSpec("demo@[2001:db8::1]", "/tmp/file"), "demo@[2001:db8::1]:/tmp/file");
  });

  it("preserves a bare host", () => {
    assert.equal(scpRemoteSpec("host", "/path"), "host:/path");
  });
});

describe("sshArgs / muxOptions", () => {
  it("includes BatchMode, mux, and remote command after -- when mux enabled", () => {
    const args = sshArgs("demo@host:2222", "true", "/tmp/mux", { muxEnabled: true });
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("2222"));
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "true");
    assert.equal(args.at(-3), "demo@host");
  });

  it("omits ControlMaster options when mux disabled", () => {
    const args = sshArgs("demo@host:2222", "true", "/tmp/mux", { muxEnabled: false });
    assert.equal(muxOptions("demo@host", "/tmp/mux", { enabled: false }).length, 0);
    assert.ok(!args.some((a) => String(a).includes("ControlMaster")));
    assert.ok(!args.some((a) => String(a).includes("ControlPath")));
    assert.ok(args.includes("BatchMode=yes"));
  });

  it("derives stable control path", () => {
    const a = controlPathFor("demo@host", "/tmp/mux");
    const b = controlPathFor("demo@host:22", "/tmp/mux");
    assert.equal(a, b);
    assert.match(a, /\/tmp\/mux\/[0-9a-f]{24}$/);
  });

  it("uses forward slashes for ControlPath on win32", () => {
    const path = controlPathFor("demo@host", "C:\\Users\\me\\.cache\\mux", { platform: "win32" });
    assert.ok(!path.includes("\\"));
    assert.match(path, /^C:\/Users\/me\/\.cache\/mux\/[0-9a-f]{24}$/);
  });
});

describe("helpers", () => {
  it("detects stale mux errors", () => {
    assert.equal(isStaleMuxError("Control socket connect failed"), true);
    assert.equal(isStaleMuxError("permission denied"), false);
  });

  it("detects Windows ControlMaster unsupported errors", () => {
    assert.equal(isMuxUnsupportedError("getsockname failed: Not a socket"), true);
    assert.equal(isMuxUnsupportedError("getsockname failed: Bad file descriptor"), true);
    assert.equal(isMuxUnsupportedError("permission denied"), false);
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
