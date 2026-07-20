import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHandlers } from "../src/app.js";
import { createJobManager } from "../src/jobs.js";
import { createMockTransport, resolveRemotePath } from "../src/transport/mock.js";
import { remoteShellCommand } from "../src/util.js";

const TARGET = "demo@mock-host:22";

function textOf(result) {
  assert.ok(result?.content?.[0]?.type === "text");
  return result.content[0].text;
}

describe("resolveRemotePath", () => {
  it("maps absolute remote paths under the sandbox root", () => {
    assert.equal(resolveRemotePath("/tmp/root", "/etc/hostname"), resolve("/tmp/root", "etc/hostname"));
    assert.equal(resolveRemotePath("/tmp/root", "rel"), resolve("/tmp/root", "rel"));
  });

  it("rejects path escape", () => {
    assert.throws(() => resolveRemotePath("/tmp/root", "../outside"), /escapes/);
  });
});

describe("createMockTransport", () => {
  /** @type {ReturnType<typeof createMockTransport>} */
  let transport;

  before(() => {
    transport = createMockTransport({ identity: { uid: "42", hostname: "unit-mock" } });
  });

  after(() => {
    transport.dispose();
  });

  it("exec runs the same remoteShellCommand string and returns stdout", async () => {
    const result = await transport.exec(TARGET, remoteShellCommand("printf 'ok\\n'"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "ok\n");
  });

  it("exec rejects non-zero unless allowNonZero", async () => {
    await assert.rejects(
      () => transport.exec(TARGET, remoteShellCommand("exit 7")),
      /code 7/,
    );
    const result = await transport.exec(TARGET, remoteShellCommand("exit 7"), { allowNonZero: true });
    assert.equal(result.code, 7);
  });

  it("scp to/from round-trips file contents", async () => {
    const localDir = mkdtempSync(join(tmpdir(), "mcp-ssh-local-"));
    try {
      const localFile = join(localDir, "payload.txt");
      writeFileSync(localFile, "hello-scp\n");
      await transport.scp(TARGET, {
        direction: "to",
        localPath: localFile,
        remotePath: "uploads/payload.txt",
      });
      const remoteAbs = transport.resolvePath("uploads/payload.txt");
      assert.equal(readFileSync(remoteAbs, "utf8"), "hello-scp\n");

      const downloaded = join(localDir, "back.txt");
      await transport.scp(TARGET, {
        direction: "from",
        localPath: downloaded,
        remotePath: "uploads/payload.txt",
      });
      assert.equal(readFileSync(downloaded, "utf8"), "hello-scp\n");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  it("close succeeds without a real mux socket", async () => {
    const result = await transport.close(TARGET);
    assert.equal(result.code, 0);
  });
});

describe("handlers via mock transport (SSH contract)", () => {
  /** @type {ReturnType<typeof createMockTransport>} */
  let transport;
  /** @type {ReturnType<typeof createHandlers>} */
  let api;
  let localDir;
  let jobManager;

  before(() => {
    transport = createMockTransport({ identity: { uid: "1000", hostname: "mock-host" } });
    localDir = mkdtempSync(join(tmpdir(), "mcp-ssh-handler-"));
    jobManager = createJobManager({ jobDir: join(localDir, "jobs") });
    api = createHandlers(transport, { jobManager });
  });

  after(() => {
    api.killAllInteractiveSessions();
    api.jobManager.killAll("SIGTERM");
    transport.dispose();
    rmSync(localDir, { recursive: true, force: true });
  });

  it("ssh_ping returns uid and hostname", async () => {
    const result = await api.handlers.ssh_ping({ target: TARGET });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "1000\nmock-host");
  });

  it("ssh_write_file + ssh_read_file round-trip", async () => {
    const path = "app/config.env";
    const write = await api.handlers.ssh_write_file({
      target: TARGET,
      path,
      content: "PORT=3000\n",
      append: false,
      create_dirs: true,
    });
    assert.equal(write.isError, undefined);
    assert.match(textOf(write), /Wrote/);

    const read = await api.handlers.ssh_read_file({ target: TARGET, path });
    assert.equal(textOf(read), "PORT=3000\n");
  });

  it("ssh_read_file supports offset and limit", async () => {
    const path = "app/lines.txt";
    await api.handlers.ssh_write_file({
      target: TARGET,
      path,
      content: "line1\nline2\nline3\nline4\nline5\n",
      append: false,
      create_dirs: true,
    });
    const partial = await api.handlers.ssh_read_file({ target: TARGET, path, offset: 2, limit: 2 });
    assert.equal(textOf(partial), "line2\nline3\n");

    const full = await api.handlers.ssh_read_file({ target: TARGET, path, limit: 0 });
    assert.equal(full.isError, undefined);
    assert.equal(textOf(full), "line1\nline2\nline3\nline4\nline5\n");
  });

  it("ssh_write_file appends when append=true", async () => {
    const path = "app/append.log";
    await api.handlers.ssh_write_file({ target: TARGET, path, content: "a\n", append: false, create_dirs: true });
    await api.handlers.ssh_write_file({ target: TARGET, path, content: "b\n", append: true, create_dirs: true });
    const read = await api.handlers.ssh_read_file({ target: TARGET, path });
    assert.equal(textOf(read), "a\nb\n");
  });

  it("ssh_mkdir creates nested directories", async () => {
    const path = "releases/42/bin";
    const result = await api.handlers.ssh_mkdir({ target: TARGET, path });
    assert.match(textOf(result), /Created directory/);
    const { statSync } = await import("node:fs");
    assert.ok(statSync(transport.resolvePath(path)).isDirectory());
  });

  it("ssh_exec returns exit_code and stdout; non-zero sets isError", async () => {
    const ok = await api.handlers.ssh_exec({ target: TARGET, command: "printf 'MCP_OK\\n'", timeout_ms: 5000 });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /^exit_code=0\nMCP_OK\n/);

    // stderr-only: combineStreams returns stderr body without a [stderr] label
    const bad = await api.handlers.ssh_exec({ target: TARGET, command: "echo fail >&2; exit 3", timeout_ms: 5000 });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /exit_code=3/);
    assert.match(textOf(bad), /fail/);

    // both streams: stderr is labeled
    const both = await api.handlers.ssh_exec({
      target: TARGET,
      command: "printf 'out\\n'; echo err >&2; exit 4",
      timeout_ms: 5000,
    });
    assert.equal(both.isError, true);
    assert.match(textOf(both), /exit_code=4/);
    assert.match(textOf(both), /^exit_code=4\nout\n\[stderr\]\nerr\n/);
  });

  it("ssh_exec supports stdin, cwd, env, and ok_codes", async () => {
    await api.handlers.ssh_mkdir({ target: TARGET, path: "releases/42" });

    const stdin = await api.handlers.ssh_exec({ target: TARGET, command: "cat", stdin: "hello\n" });
    assert.equal(stdin.isError, undefined);
    assert.match(textOf(stdin), /exit_code=0/);
    assert.match(textOf(stdin), /hello/);

    const cwd = await api.handlers.ssh_exec({ target: TARGET, command: "pwd", cwd: "releases/42" });
    assert.equal(cwd.isError, undefined);
    assert.match(textOf(cwd), /releases\/42/);

    const env = await api.handlers.ssh_exec({ target: TARGET, command: "printf '%s\\n' \"$FOO\"", env: { FOO: "bar" } });
    assert.equal(env.isError, undefined);
    assert.match(textOf(env), /bar/);

    const ok = await api.handlers.ssh_exec({ target: TARGET, command: "exit 7", ok_codes: [7] });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /exit_code=7/);
  });

  it("ssh_list_dir lists created files with ls -lAh metadata", async () => {
    await api.handlers.ssh_write_file({ target: TARGET, path: "listed/a.txt", content: "x", append: false, create_dirs: true });
    const result = await api.handlers.ssh_list_dir({ target: TARGET, path: "listed" });
    const text = textOf(result);
    assert.match(text, /a\.txt/);
    assert.match(text, /total/);
    assert.match(text, /[-d][r-][w-][x-]/);
  });

  it("ssh_grep finds matches and reports no matches cleanly", async () => {
    await api.handlers.ssh_write_file({
      target: TARGET,
      path: "src/todo.js",
      content: "// TODO: fix\nconst x = 1;\n",
      append: false,
      create_dirs: true,
    });
    const hit = await api.handlers.ssh_grep({ target: TARGET, pattern: "TODO", path: "src" });
    assert.equal(hit.isError, undefined);
    assert.match(textOf(hit), /TODO/);

    const miss = await api.handlers.ssh_grep({ target: TARGET, pattern: "NO_SUCH_TOKEN_XYZ", path: "src" });
    assert.equal(miss.isError, undefined);
    assert.match(textOf(miss), /no matches/);
  });

  it("ssh_grep supports ripgrep-like options", async () => {
    await api.handlers.ssh_write_file({
      target: TARGET,
      path: "src/items.txt",
      content: "TODO clean\nTodo refactor\ntodo final\nother line\n",
      append: false,
      create_dirs: true,
    });

    const ci = await api.handlers.ssh_grep({ target: TARGET, pattern: "todo", path: "src", ignore_case: true });
    assert.equal(ci.isError, undefined);
    assert.match(textOf(ci), /TODO clean/);
    assert.match(textOf(ci), /Todo refactor/);
    assert.match(textOf(ci), /todo final/);

    const fixed = await api.handlers.ssh_grep({ target: TARGET, pattern: "a.b", path: "src", fixed_strings: true });
    assert.equal(fixed.isError, undefined);
    assert.equal(textOf(fixed).includes("TODO clean"), false);
    assert.equal(textOf(fixed).includes("const x = 1"), false);

    const limited = await api.handlers.ssh_grep({ target: TARGET, pattern: "todo", path: "src", ignore_case: true, max_results: 2 });
    assert.equal(limited.isError, undefined);
    const limitedText = textOf(limited);
    assert.match(limitedText, /TODO clean/);
    assert.match(limitedText, /Todo refactor/);
  });

  it("ssh_apply_patch supports dry-run and strip", async () => {
    const available = await api.handlers.ssh_exec({
      target: TARGET,
      command: "if command -v patch >/dev/null 2>&1 || command -v git >/dev/null 2>&1; then echo ok; fi",
    });
    if (!textOf(available).includes("ok")) return;

    await api.handlers.ssh_write_file({ target: TARGET, path: "patches/a.txt", content: "old\n", append: false, create_dirs: true });
    await api.handlers.ssh_write_file({ target: TARGET, path: "patches/b.txt", content: "new\n", append: false, create_dirs: true });

    const diff = await api.handlers.ssh_exec({ target: TARGET, command: "diff -u patches/a.txt patches/b.txt", ok_codes: [1] });
    const patchText = textOf(diff).replace(/^exit_code=1\n/, "");

    const dry = await api.handlers.ssh_apply_patch({ target: TARGET, patch: patchText, strip: 0, dry_run: true });
    assert.equal(dry.isError, undefined);

    const before = await api.handlers.ssh_read_file({ target: TARGET, path: "patches/a.txt" });
    assert.equal(textOf(before), "old\n");

    const applied = await api.handlers.ssh_apply_patch({ target: TARGET, patch: patchText, strip: 0 });
    assert.equal(applied.isError, undefined);

    const after = await api.handlers.ssh_read_file({ target: TARGET, path: "patches/a.txt" });
    assert.equal(textOf(after), "new\n");
  });

  it("ssh_delete removes a file", async () => {
    const path = "tmp/deleteme.txt";
    await api.handlers.ssh_write_file({ target: TARGET, path, content: "bye", append: false, create_dirs: true });
    const del = await api.handlers.ssh_delete({ target: TARGET, path, recursive: false });
    assert.match(textOf(del), /Deleted/);
    const read = await api.handlers.ssh_read_file({ target: TARGET, path });
    assert.equal(read.isError, true);
  });

  it("ssh_scp_to / ssh_scp_from via handlers", async () => {
    const localFile = join(localDir, "up.txt");
    writeFileSync(localFile, "via-handler\n");
    const up = await api.handlers.ssh_scp_to({
      target: TARGET,
      local_path: localFile,
      remote_path: "scp/up.txt",
      recursive: false,
      timeout_ms: 5000,
    });
    assert.match(textOf(up), /Uploaded/);

    const down = join(localDir, "down.txt");
    const got = await api.handlers.ssh_scp_from({
      target: TARGET,
      remote_path: "scp/up.txt",
      local_path: down,
      recursive: false,
      timeout_ms: 5000,
    });
    assert.match(textOf(got), /Downloaded/);
    assert.equal(readFileSync(down, "utf8"), "via-handler\n");
  });

  it("ssh_close reports closed connection when mux is on", async () => {
    const result = await api.handlers.ssh_close({ target: TARGET });
    assert.match(textOf(result), /Closed multiplexed connection/);
  });

  it("ssh_close explains when multiplexing is disabled", async () => {
    const { createHandlers } = await import("../src/app.js");
    const { createMockTransport } = await import("../src/transport/mock.js");
    const transport = createMockTransport();
    transport.getMuxEnabled = () => false;
    const { handlers } = createHandlers(transport);
    const result = await handlers.ssh_close({ target: TARGET });
    assert.match(textOf(result), /Multiplexing is disabled/);
    transport.dispose();
  });

  it("ssh_interactive_exec + input for a prompting script", async () => {
    // Script that prints a prompt, reads a line, echoes it, exits.
    const script = [
      "printf 'Password: '",
      "IFS= read -r line",
      "printf 'got=%s\\n' \"$line\"",
    ].join("; ");

    const started = await api.handlers.ssh_interactive_exec({
      target: TARGET,
      command: script,
      quiet_ms: 200,
    });
    assert.equal(started.isError, undefined);
    const startText = textOf(started);
    assert.match(startText, /session_id=/);
    assert.match(startText, /Password:/);
    const sessionId = startText.match(/session_id=([^\n]+)/)[1];

    const replied = await api.handlers.ssh_interactive_input({
      session_id: sessionId,
      input: "secret",
      newline: true,
      quiet_ms: 200,
    });
    assert.match(textOf(replied), /got=secret/);
    assert.match(textOf(replied), /exited \(code 0\)/);

    const list = await api.handlers.ssh_interactive_list({});
    assert.match(textOf(list), /no active interactive sessions/);
  });

  it("ssh_interactive_exec captures stderr in the session buffer", async () => {
    const started = await api.handlers.ssh_interactive_exec({
      target: TARGET,
      command: "printf 'err\\n' >&2; printf 'out\\n'",
      quiet_ms: 150,
    });
    const text = textOf(started);
    assert.match(text, /err/);
    assert.match(text, /out/);
    assert.match(text, /exited \(code 0\)/);
  });

  it("ssh_interactive_close removes a running session", async () => {
    const started = await api.handlers.ssh_interactive_exec({
      target: TARGET,
      command: "printf 'ready\\n'; sleep 5",
      quiet_ms: 150,
    });
    const sessionId = textOf(started).match(/session_id=([^\n]+)/)[1];
    const closed = await api.handlers.ssh_interactive_close({ session_id: sessionId });
    assert.match(textOf(closed), /Closed interactive session/);
    const list = await api.handlers.ssh_interactive_list({});
    assert.match(textOf(list), /no active/);
  });

  it("ssh_read_image returns MCP image content", async () => {
    // Minimal 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const path = "img/pixel.png";
    mkdirSync(transport.resolvePath("img"), { recursive: true });
    writeFileSync(transport.resolvePath(path), png);

    const result = await api.handlers.ssh_read_image({ target: TARGET, path });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/png");
    assert.equal(Buffer.from(result.content[0].data, "base64").equals(png), true);
  });

  it("invalid target surfaces as isError without throwing", async () => {
    const result = await api.handlers.ssh_ping({ target: "not-a-target" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /user@host/);
  });

  it("ssh_exec background starts a detached job and returns a job_id", async () => {
    const started = await api.handlers.ssh_exec({
      target: TARGET,
      command: "sleep 0.2; echo 'job done'",
      background: true,
    });
    assert.equal(started.isError, undefined);
    const text = textOf(started);
    assert.match(text, /job_id=/);
    assert.match(text, /status=started/);

    const jobId = text.match(/job_id=([^\n]+)/)[1];
    const result = await api.handlers.ssh_exec_result({
      job_id: jobId,
      wait: true,
      timeout_ms: 5000,
    });
    assert.equal(result.isError, undefined);
    const resultText = textOf(result);
    assert.match(resultText, /status=exited/);
    assert.match(resultText, /job done/);
    assert.match(resultText, /exit_code=0/);
  });

  it("ssh_exec background rejects stdin", async () => {
    const result = await api.handlers.ssh_exec({
      target: TARGET,
      command: "cat",
      background: true,
      stdin: "x\n",
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /stdin.*background/);
  });

  it("ssh_exec_kill stops a background job and can clean up", async () => {
    const started = await api.handlers.ssh_exec({
      target: TARGET,
      command: "sleep 60",
      background: true,
    });
    const jobId = textOf(started).match(/job_id=([^\n]+)/)[1];

    const killed = await api.handlers.ssh_exec_kill({ job_id: jobId, signal: "SIGTERM" });
    assert.equal(killed.isError, undefined);
    assert.match(textOf(killed), /killed=true/);

    const result = await api.handlers.ssh_exec_result({ job_id: jobId, wait: true, timeout_ms: 2000 });
    assert.match(textOf(result), /status=exited/);

    const cleaned = await api.handlers.ssh_exec_kill({ job_id: jobId, cleanup: true });
    assert.match(textOf(cleaned), /cleaned=true/);
  });
});
