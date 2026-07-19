import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHandlers } from "../src/app.js";
import { createMockTransport, resolveRemotePath } from "../src/transport/mock.js";
import { remoteShellCommand } from "../src/util.js";

const TARGET = "demo@mock-host:22";

function textOf(result) {
  assert.ok(result?.content?.[0]?.type === "text");
  return result.content[0].text;
}

describe("resolveRemotePath", () => {
  it("maps absolute remote paths under the sandbox root", () => {
    assert.equal(resolveRemotePath("/tmp/root", "/etc/hostname"), "/tmp/root/etc/hostname");
    assert.equal(resolveRemotePath("/tmp/root", "rel"), "/tmp/root/rel");
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

  before(() => {
    transport = createMockTransport({ identity: { uid: "1000", hostname: "mock-host" } });
    api = createHandlers(transport);
    localDir = mkdtempSync(join(tmpdir(), "mcp-ssh-handler-"));
  });

  after(() => {
    api.killAllInteractiveSessions();
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

  it("ssh_list_dir lists created files", async () => {
    await api.handlers.ssh_write_file({ target: TARGET, path: "listed/a.txt", content: "x", append: false, create_dirs: true });
    const result = await api.handlers.ssh_list_dir({ target: TARGET, path: "listed" });
    assert.match(textOf(result), /a\.txt/);
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
});
