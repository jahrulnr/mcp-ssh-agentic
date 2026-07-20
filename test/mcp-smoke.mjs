#!/usr/bin/env node

/**
 * MCP stdio smoke test against the real bin entry, with mock SSH transport.
 *
 * Modes (env MCP_SMOKE_MODE):
 *   node  — spawn `node src/cli.js` (default)
 *   npx   — `npm pack` then `npx -y ./pkg.tgz` (catches bin/symlink regressions)
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
const mode = process.argv[2] || process.env.MCP_SMOKE_MODE || "node";
const TARGET = "demo@mock-host:22";

function textOf(result) {
  const block = result?.content?.find((c) => c.type === "text");
  assert.ok(block, "expected text content in tool result");
  return block.text;
}

async function packForNpx() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-ssh-pack-"));
  const child = spawn("npm", ["pack", "--pack-destination", dir], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`npm pack failed (${code}): ${err || out}`);
  const tarball = out.trim().split("\n").filter(Boolean).at(-1);
  if (!tarball) throw new Error(`npm pack produced no tarball: ${out}`);
  return { dir, tarball: join(dir, tarball) };
}

async function main() {
  /** @type {{ dir?: string, tarball?: string }} */
  let packed = {};
  /** @type {{ command: string, args: string[], env: NodeJS.ProcessEnv }} */
  let server;

  if (mode === "npx") {
    packed = await packForNpx();
    // `npx ./file.tgz` tries to execute the archive; use --package + bin name instead.
    server = {
      command: "npx",
      args: ["-y", `--package=${packed.tarball}`, "mcp-ssh-agentic"],
      env: {
        ...process.env,
        MCP_SSH_AGENTIC_MOCK: "1",
        npm_config_yes: "true",
      },
    };
  } else if (mode === "node") {
    server = {
      command: process.execPath,
      args: [join(root, "src", "cli.js")],
      env: {
        ...process.env,
        MCP_SSH_AGENTIC_MOCK: "1",
      },
    };
  } else {
    throw new Error(`unknown MCP_SMOKE_MODE=${mode} (use node|npx)`);
  }

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
    ]) {
      assert.ok(names.has(required), `missing tool ${required}`);
    }

    const ping = await client.callTool({ name: "ssh_ping", arguments: { target: TARGET } });
    assert.equal(ping.isError, undefined);
    assert.match(textOf(ping), /1000\nmock-host/);

    const exec = await client.callTool({
      name: "ssh_exec",
      arguments: { target: TARGET, command: "printf 'MCP_SMOKE_OK\\n'", timeout_ms: 5000 },
    });
    assert.equal(exec.isError, undefined);
    assert.match(textOf(exec), /exit_code=0/);
    assert.match(textOf(exec), /MCP_SMOKE_OK/);

    const write = await client.callTool({
      name: "ssh_write_file",
      arguments: {
        target: TARGET,
        path: "smoke/hello.txt",
        content: "hello-mcp\n",
        append: false,
        create_dirs: true,
      },
    });
    assert.equal(write.isError, undefined);

    const read = await client.callTool({
      name: "ssh_read_file",
      arguments: { target: TARGET, path: "smoke/hello.txt" },
    });
    assert.equal(read.isError, undefined);
    assert.equal(textOf(read), "hello-mcp\n");

    console.log(`mcp-smoke ok mode=${mode} server=${init.name}@${init.version} tools=${tools.length}`);
  } catch (error) {
    if (stderr.trim()) console.error("--- server stderr ---\n" + stderr);
    throw error;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
    if (packed.dir) rmSync(packed.dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
