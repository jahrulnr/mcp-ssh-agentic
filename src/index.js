#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { createRealTransport } from "./transport/real.js";

const MUX_DIR = join(homedir(), ".cache", "mcp-ssh-agentic", "mux");

export { createApp } from "./app.js";
export { createRealTransport } from "./transport/real.js";
export { createMockTransport } from "./transport/mock.js";
export * from "./util.js";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const transport = createRealTransport({ muxDir: MUX_DIR });
  const { server, dispose } = createApp(transport);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { dispose(); process.exit(0); });
  }
  process.on("exit", dispose);

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}
