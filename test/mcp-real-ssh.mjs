#!/usr/bin/env node

/**
 * MCP stdio smoke test against a real SSH server (Docker-based).
 * Assumes a Docker SSH server is running and reachable via the target
 * configured in the MCP_REAL_SSH_TARGET env var (default: test@localhost:2222).
 * Set HOME to a temp home containing .ssh/config with IdentityFile if needed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.MCP_REAL_SSH_TARGET || "test@localhost:2222";

function textOf(result) {
  const block = result?.content?.find((c) => c.type === "text");
  assert.ok(block, "expected text content in tool result");
  return block.text;
}

async function main() {
  const server = {
    command: process.execPath,
    args: [join(root, "src", "cli.js")],
    env: {
      ...process.env,
      // Ensure real transport is used; cli.js picks mock only if MCP_SSH_AGENTIC_MOCK is set.
      MCP_SSH_AGENTIC_MOCK: "",
    },
  };

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: root,
    stderr: "pipe",
  });

  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const client = new Client({ name: "mcp-ssh-agentic-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);

    const init = client.getServerVersion();
    assert.equal(init?.name, "mcp-ssh-agentic");
    assert.ok(init?.version, "server version missing");

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      "ssh_ping",
      "ssh_exec",
      "ssh_write_file",
      "ssh_read_file",
      "ssh_close",
      "ssh_exec_result",
      "ssh_exec_kill",
    ]) {
      assert.ok(names.has(required), `missing tool ${required}`);
    }

    const ping = await client.callTool({ name: "ssh_ping", arguments: { target: TARGET } });
    assert.equal(ping.isError, undefined);
    assert.match(textOf(ping), /911\n[0-9a-f]+/);

    const exec = await client.callTool({
      name: "ssh_exec",
      arguments: { target: TARGET, command: "printf 'MCP_REAL_SSH_OK\\n'", timeout_ms: 10000 },
    });
    assert.equal(exec.isError, undefined);
    assert.match(textOf(exec), /exit_code=0/);
    assert.match(textOf(exec), /MCP_REAL_SSH_OK/);

    const write = await client.callTool({
      name: "ssh_write_file",
      arguments: {
        target: TARGET,
        path: "/tmp/mcp-real/hello.txt",
        content: "hello-real-ssh\n",
        append: false,
        create_dirs: true,
      },
    });
    assert.equal(write.isError, undefined);

    const read = await client.callTool({
      name: "ssh_read_file",
      arguments: { target: TARGET, path: "/tmp/mcp-real/hello.txt" },
    });
    assert.equal(read.isError, undefined);
    assert.equal(textOf(read), "hello-real-ssh\n");

    const list = await client.callTool({
      name: "ssh_list_dir",
      arguments: { target: TARGET, path: "/tmp/mcp-real" },
    });
    assert.equal(list.isError, undefined);
    assert.match(textOf(list), /hello\.txt/);

    // Background exec real test
    const bg = await client.callTool({
      name: "ssh_exec",
      arguments: { target: TARGET, command: "sleep 0.2; echo 'bg done'", background: true },
    });
    assert.equal(bg.isError, undefined);
    assert.match(textOf(bg), /job_id=/);
    const jobId = textOf(bg).match(/job_id=([^\n]+)/)[1];

    const bgResult = await client.callTool({
      name: "ssh_exec_result",
      arguments: { job_id: jobId, wait: true, timeout_ms: 10000 },
    });
    assert.equal(bgResult.isError, undefined);
    assert.match(textOf(bgResult), /status=exited/);
    assert.match(textOf(bgResult), /bg done/);

    const grep = await client.callTool({
      name: "ssh_grep",
      arguments: { target: TARGET, pattern: "hello-real", path: "/tmp/mcp-real" },
    });
    assert.equal(grep.isError, undefined);
    assert.match(textOf(grep), /hello-real/);

    const close = await client.callTool({ name: "ssh_close", arguments: { target: TARGET } });
    assert.equal(close.isError, undefined);

    console.log(`mcp-real-ssh ok target=${TARGET} server=${init.name}@${init.version} tools=${tools.length}`);
  } catch (error) {
    if (stderr.trim()) console.error("--- server stderr ---\n" + stderr);
    throw error;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
