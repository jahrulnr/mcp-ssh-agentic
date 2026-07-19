#!/usr/bin/env node

/**
 * Library entry + `node src/index.js` convenience launcher.
 * Prefer the `mcp-ssh-agentic` bin (`src/cli.js`) for npx — that path always starts.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { createRealTransport } from "./transport/real.js";

const MUX_DIR = join(homedir(), ".cache", "mcp-ssh-agentic", "mux");

export { createApp } from "./app.js";
export { createRealTransport } from "./transport/real.js";
export { createMockTransport } from "./transport/mock.js";
export * from "./util.js";

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  const transport = createRealTransport({ muxDir: MUX_DIR });
  const { server, dispose } = createApp(transport);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { dispose(); process.exit(0); });
  }
  process.on("exit", dispose);

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}
