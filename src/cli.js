#!/usr/bin/env node

/**
 * Bin entry for npx / npm link. Always starts the MCP server.
 * (Do not use isMain checks here — npm bin is a symlink, so import.meta.url
 * !== pathToFileURL(process.argv[1]).href and the old guard never started.)
 *
 * Set MCP_SSH_AGENTIC_MOCK=1 to use the in-process mock transport (CI / local smoke).
 */
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { createRealTransport } from "./transport/real.js";
import { createMockTransport } from "./transport/mock.js";

const MUX_DIR = join(homedir(), ".cache", "mcp-ssh-agentic", "mux");
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const useMock = /^(1|true|yes)$/i.test(String(process.env.MCP_SSH_AGENTIC_MOCK || ""));
const transport = useMock
  ? createMockTransport()
  : createRealTransport({ muxDir: MUX_DIR });

const { server, dispose } = createApp(transport, { version: pkg.version });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { dispose(); process.exit(0); });
}
process.on("exit", dispose);

const stdio = new StdioServerTransport();
await server.connect(stdio);
