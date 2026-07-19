import { dirname as posixDirname } from "node:path/posix";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  INTERACTIVE_MAX_SESSIONS,
  INTERACTIVE_QUIET_MS_DEFAULT,
  INTERACTIVE_SESSION_TTL_MS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  appendToSessionBuffer,
  combineStreams,
  decodeUtf8,
  describeLocalClient,
  drainSessionOutput,
  formatBytes,
  formatFailure,
  parseTarget,
  remoteListDirCommand,
  remoteShellCommand,
  resolveMuxEnabled,
  safe,
  settleSession,
  shellQuote,
  textResult,
} from "./util.js";

const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

/**
 * @param {import('./transport/contract.js').SshTransport} transport
 * @param {{ interactiveSessions?: Map<string, object>, now?: () => number, randomId?: () => string }} [opts]
 */
export function createHandlers(transport, {
  interactiveSessions = new Map(),
  now = () => Date.now(),
  randomId = () => randomUUID(),
} = {}) {
  function killSessionChild(session) {
    const child = session.child;
    if (!child || child.killed) return;
    try {
      // Negative PID = process group; only works on Unix. Windows (cmd/PowerShell/Git Bash Node) uses child.kill.
      if (SUPPORTS_PROCESS_GROUPS && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }

  function pruneStaleSessions() {
    const t = now();
    for (const [id, session] of interactiveSessions) {
      if (session.exited || t - session.lastActivity > INTERACTIVE_SESSION_TTL_MS) {
        if (!session.exited) killSessionChild(session);
        interactiveSessions.delete(id);
      }
    }
  }

  function killAllInteractiveSessions() {
    for (const session of interactiveSessions.values()) {
      killSessionChild(session);
    }
    interactiveSessions.clear();
  }

  const handlers = {
    ssh_ping: async ({ target }) => safe(async () => {
      const result = await transport.exec(target, remoteShellCommand("id -u && hostname"), { timeoutMs: 15000 });
      return textResult(decodeUtf8(result.stdout).trim());
    }),

    ssh_read_file: async ({ target, path }) => safe(async () => {
      const result = await transport.exec(target, remoteShellCommand(`cat -- ${shellQuote(path)}`));
      return textResult(decodeUtf8(result.stdout));
    }),

    ssh_write_file: async ({ target, path, content, append = false, create_dirs = true }) => safe(async () => {
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error(`content exceeds ${MAX_TEXT_BYTES} bytes`);
      const mkdirCmd = create_dirs ? `mkdir -p -- ${shellQuote(posixDirname(path))} && ` : "";
      const redirect = append ? ">>" : ">";
      const command = `${mkdirCmd}cat ${redirect} ${shellQuote(path)}`;
      await transport.exec(target, remoteShellCommand(command), { stdin: content, maxBytes: MAX_TEXT_BYTES });
      return textResult(`${append ? "Appended to" : "Wrote"} ${target}:${path} (${Buffer.byteLength(content, "utf8")} bytes)`);
    }),

    ssh_mkdir: async ({ target, path }) => safe(async () => {
      await transport.exec(target, remoteShellCommand(`mkdir -p -- ${shellQuote(path)}`));
      return textResult(`Created directory ${target}:${path}`);
    }),

    ssh_read_image: async ({ target, path }) => safe(async () => {
      const result = await transport.exec(target, remoteShellCommand(`base64 < ${shellQuote(path)}`), { maxBytes: MAX_IMAGE_BYTES * 2 });
      const ext = path.toLowerCase().split(".").pop();
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" })[ext] || "application/octet-stream";
      const data = Buffer.from(decodeUtf8(result.stdout).replace(/\s+/g, ""), "base64");
      if (data.length > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
      return { content: [{ type: "image", data: data.toString("base64"), mimeType: mime }, { type: "text", text: `${path} (${mime}, ${data.length} bytes)` }] };
    }),

    ssh_list_dir: async ({ target, path = "." }) => safe(async () => {
      const result = await transport.exec(target, remoteShellCommand(remoteListDirCommand(path)));
      return textResult(decodeUtf8(result.stdout));
    }),

    ssh_grep: async ({ target, pattern, path = ".", glob }) => safe(async () => {
      const globArg = glob ? `--glob ${shellQuote(glob)}` : "";
      const remote = [
        "set +e",
        "if command -v rg >/dev/null 2>&1; then",
        `  out=$(rg -n --hidden --no-messages ${globArg} -- ${shellQuote(pattern)} ${shellQuote(path)} 2>/dev/null)`,
        "  ec=$?",
        "else",
        `  out=$(grep -RIn --exclude-dir=.git --exclude-dir=node_modules ${shellQuote(pattern)} ${shellQuote(path)} 2>/dev/null)`,
        "  ec=$?",
        "fi",
        "printf '%s' \"$out\"",
        "if [ \"$ec\" -eq 0 ] || [ \"$ec\" -eq 1 ]; then exit 0; fi",
        "if [ -n \"$out\" ]; then exit 0; fi",
        "exit \"$ec\"",
      ].join("\n");

      const result = await transport.exec(target, remoteShellCommand(remote), { maxBytes: MAX_TEXT_BYTES, allowNonZero: true });
      const stdout = decodeUtf8(result.stdout);
      const stderr = decodeUtf8(result.stderr).trim();
      if (result.code === 0) {
        return textResult(stdout || "(no matches)\n");
      }
      if (stdout.trim()) {
        return textResult(combineStreams(stdout, stderr));
      }
      throw new Error(formatFailure(result));
    }),

    ssh_apply_patch: async ({ target, patch }) => safe(async () => {
      const result = await transport.exec(target, remoteShellCommand("if command -v apply_patch >/dev/null 2>&1; then apply_patch; else patch -p0; fi"), { stdin: patch, maxBytes: MAX_TEXT_BYTES });
      return textResult(decodeUtf8(result.stdout) || "Patch applied successfully.");
    }),

    ssh_delete: async ({ target, path, recursive = false }) => safe(async () => {
      const command = recursive ? `rm -rf -- ${shellQuote(path)}` : `rm -f -- ${shellQuote(path)}`;
      await transport.exec(target, remoteShellCommand(command));
      return textResult(`Deleted ${path}${recursive ? " recursively" : ""}.`);
    }),

    ssh_exec: async ({ target, command, timeout_ms = 30000 }) => safe(async () => {
      const result = await transport.exec(target, remoteShellCommand(command), {
        timeoutMs: timeout_ms,
        maxBytes: MAX_TEXT_BYTES,
        allowNonZero: true,
      });
      const stdout = decodeUtf8(result.stdout);
      const stderr = decodeUtf8(result.stderr);
      const code = result.code ?? 1;
      const body = combineStreams(stdout, stderr);
      return textResult(`exit_code=${code}\n${body}`, { isError: code !== 0 });
    }),

    ssh_interactive_exec: async ({ target, command, quiet_ms = INTERACTIVE_QUIET_MS_DEFAULT }) => safe(async () => {
      pruneStaleSessions();
      if (interactiveSessions.size >= INTERACTIVE_MAX_SESSIONS) {
        throw new Error(`too many open interactive sessions (max ${INTERACTIVE_MAX_SESSIONS}); close one with ssh_interactive_close first`);
      }
      const child = transport.spawnInteractive(target, remoteShellCommand(command));
      const id = randomId();
      const session = {
        id, child, target, command,
        chunks: [], bufferedBytes: 0, truncated: false,
        exited: false, exitCode: null,
        lastDataAt: now(), lastActivity: now(),
      };
      child.stdout.on("data", (chunk) => { appendToSessionBuffer(session, chunk); session.lastDataAt = now(); });
      child.stderr?.on("data", (chunk) => { appendToSessionBuffer(session, chunk); session.lastDataAt = now(); });
      child.on("exit", (code, signal) => { session.exited = true; session.exitCode = code ?? (signal ? 1 : 0); });
      child.on("error", (error) => { session.exited = true; session.exitCode = 1; session.error = error.message; });
      interactiveSessions.set(id, session);

      session.lastDataAt = now();
      await settleSession(session, { quietMs: quiet_ms });
      const { text, truncated } = drainSessionOutput(session);
      session.lastActivity = now();
      const stillOpen = !session.exited;
      if (!stillOpen) interactiveSessions.delete(id);
      const status = stillOpen ? "running (send input with ssh_interactive_input, or poll by omitting input)" : `exited (code ${session.exitCode})`;
      const header = stillOpen ? `session_id=${id}\nstatus=${status}` : `status=${status}`;
      return textResult(`${header}\n${truncated ? "[output truncated to fit buffer]\n" : ""}${text}`);
    }),

    ssh_interactive_input: async ({ session_id, input, newline = true, quiet_ms = INTERACTIVE_QUIET_MS_DEFAULT }) => safe(async () => {
      const session = interactiveSessions.get(session_id);
      if (!session) throw new Error(`no active interactive session with id ${session_id} (it may have already exited or expired)`);
      if (input !== undefined) session.child.stdin.write(input + (newline ? "\n" : ""));
      session.lastActivity = now();
      session.lastDataAt = now();

      await settleSession(session, { quietMs: quiet_ms });
      const { text, truncated } = drainSessionOutput(session);
      const stillOpen = !session.exited;
      const status = stillOpen ? "running" : `exited (code ${session.exitCode})`;
      if (!stillOpen) interactiveSessions.delete(session_id);
      return textResult(`status=${status}\n${truncated ? "[output truncated to fit buffer]\n" : ""}${text}`);
    }),

    ssh_interactive_close: async ({ session_id }) => safe(async () => {
      const session = interactiveSessions.get(session_id);
      if (!session) return textResult(`no active session ${session_id} (already closed or expired)`);
      killSessionChild(session);
      interactiveSessions.delete(session_id);
      return textResult(`Closed interactive session ${session_id}`);
    }),

    ssh_interactive_list: async () => safe(async () => {
      pruneStaleSessions();
      if (interactiveSessions.size === 0) return textResult("(no active interactive sessions)");
      const lines = [...interactiveSessions.values()].map((s) =>
        `${s.id}  ${s.target}  idle=${Math.round((now() - s.lastActivity) / 1000)}s  cmd=${s.command}`);
      return textResult(lines.join("\n"));
    }),

    ssh_scp_to: async ({ target, local_path, remote_path, recursive = false, timeout_ms = 120000 }) => safe(async () => {
      const st = statSync(local_path);
      await transport.scp(target, {
        direction: "to",
        localPath: local_path,
        remotePath: remote_path,
        recursive,
        timeoutMs: timeout_ms,
      });
      const size = st.isFile() ? formatBytes(st.size) : "directory";
      return textResult(`Uploaded ${local_path} → ${target}:${remote_path} (${size}${recursive ? ", recursive" : ""})`);
    }),

    ssh_scp_from: async ({ target, remote_path, local_path, recursive = false, timeout_ms = 120000 }) => safe(async () => {
      await transport.scp(target, {
        direction: "from",
        localPath: local_path,
        remotePath: remote_path,
        recursive,
        timeoutMs: timeout_ms,
      });
      let detail = "";
      if (existsSync(local_path)) {
        const st = statSync(local_path);
        detail = st.isFile() ? ` (${formatBytes(st.size)})` : " (directory)";
      }
      return textResult(`Downloaded ${target}:${remote_path} → ${local_path}${detail}${recursive ? " recursive" : ""}`);
    }),

    ssh_close: async ({ target }) => safe(async () => {
      const { userHost } = parseTarget(target);
      const muxOn = typeof transport.getMuxEnabled === "function" ? transport.getMuxEnabled() : true;
      if (!muxOn) {
        return textResult(
          `Multiplexing is disabled on this client (${describeLocalClient()}); nothing to close for ${userHost}. `
          + "SSH still works — each call opens a fresh connection. Set MCP_SSH_AGENTIC_MUX=1 to force mux if your ssh supports ControlMaster (e.g. WSL).",
        );
      }
      const result = await transport.close(target);
      if (result.code === 0) return textResult(`Closed multiplexed connection to ${userHost}`);
      const err = decodeUtf8(result.stderr).trim();
      return textResult(`No active multiplexed connection for ${userHost}${err ? ` (${err})` : ""}`);
    }),
  };

  return { handlers, interactiveSessions, pruneStaleSessions, killAllInteractiveSessions };
}

/**
 * Build an MCP server with the given transport (real or mock).
 * @param {import('./transport/contract.js').SshTransport} transport
 * @param {{ version?: string }} [meta]
 */
export function createApp(transport, { version = "0.4.0" } = {}) {
  const { handlers, interactiveSessions, pruneStaleSessions, killAllInteractiveSessions } = createHandlers(transport);

  const target = z.string().describe("SSH target in the form user@host[:port]. Uses the local SSH config and keys.");
  const path = z.string().min(1).describe("Absolute or relative path on the remote host.");
  const localPath = z.string().min(1).describe("Absolute or relative path on the local machine.");

  const muxOn = typeof transport.getMuxEnabled === "function" ? transport.getMuxEnabled() : resolveMuxEnabled();
  const client = describeLocalClient();
  const muxInstructions = muxOn
    ? "SSH ControlMaster multiplexing is enabled (socket under ~/.cache/mcp-ssh-agentic/mux, ControlPersist=600s). Use ssh_close to drop the master."
    : `SSH ControlMaster multiplexing is disabled on this client (${client}). `
      + "Native Windows OpenSSH (cmd.exe, PowerShell, and Git Bash when using Win32-OpenSSH) does not support ControlMaster; each call uses a fresh SSH connection. "
      + "Prefer WSL for multiplexing, or set MCP_SSH_AGENTIC_MUX=1 only if your ssh client actually supports ControlMaster.";

  const server = new McpServer({
    name: "mcp-ssh-agentic",
    version,
  }, {
    instructions: [
      "Remote operations use the local ssh/scp binaries with BatchMode=yes.",
      muxInstructions,
      "Do not assume a command succeeded unless its tool result says so.",
      "All remote commands run inside a non-login, non-interactive shell (bash --noprofile --norc, or sh) so broken /etc/profile.d scripts cannot corrupt output.",
      "ssh_exec reports exit_code and may include [stderr]; non-zero exits set isError but still return stdout.",
      "ssh_write_file writes text content directly to a remote file (no local temp file needed); ssh_mkdir creates remote directories.",
      "For commands that may prompt for input (sudo password, y/N confirmations, wizards, REPLs), use ssh_interactive_exec (allocates a remote PTY) followed by ssh_interactive_input to reply or poll; close sessions with ssh_interactive_close when done.",
      "ssh_scp_to uploads local→remote; ssh_scp_from downloads remote→local.",
    ].join(" "),
  });

  server.tool("ssh_ping", "Test passwordless SSH connectivity and return the remote identity.", { target }, handlers.ssh_ping);
  server.tool("ssh_read_file", "Read a UTF-8 text file from a remote host.", { target, path }, handlers.ssh_read_file);
  server.tool("ssh_write_file", "Write UTF-8 text content directly to a file on the remote host (creates or overwrites; use append=true to append instead). Avoids the round-trip of writing a local temp file and scp-ing it.", {
    target, path,
    content: z.string().describe("Text content to write to the remote file."),
    append: z.boolean().default(false).describe("Append to the file instead of overwriting it."),
    create_dirs: z.boolean().default(true).describe("Create the parent directory on the remote host if it does not exist."),
  }, handlers.ssh_write_file);
  server.tool("ssh_mkdir", "Create a directory (and parents) on the remote host, equivalent to mkdir -p.", { target, path }, handlers.ssh_mkdir);
  server.tool("ssh_read_image", "Read a remote image and return it as an MCP image. Supports common raster formats.", { target, path }, handlers.ssh_read_image);
  server.tool("ssh_list_dir", "List a remote directory with file metadata.", { target, path: path.default(".") }, handlers.ssh_list_dir);
  server.tool("ssh_grep", "Search remote text files recursively with ripgrep, falling back to grep.", {
    target, pattern: z.string().min(1), path: path.default("."), glob: z.string().optional(),
  }, handlers.ssh_grep);
  server.tool("ssh_apply_patch", "Apply a unified diff on the remote host using apply_patch, or patch as fallback.", { target, patch: z.string().min(1) }, handlers.ssh_apply_patch);
  server.tool("ssh_delete", "Delete a remote file or directory. Directories require recursive=true.", { target, path, recursive: z.boolean().default(false) }, handlers.ssh_delete);
  server.tool("ssh_exec", "Execute an intentional shell command on the remote host.", {
    target,
    command: z.string().min(1),
    timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  }, handlers.ssh_exec);
  server.tool("ssh_interactive_exec", "Start a command on the remote host with a PTY allocated, for programs that prompt for input (sudo asking for a password, y/N confirmations, setup wizards, REPLs). Waits until output goes quiet (likely waiting for input) or the process exits, then returns the output so far plus a session_id. If the command finishes without prompting, the session is closed automatically and there is nothing further to do. Otherwise, use ssh_interactive_input to reply or poll, and ssh_interactive_close when finished. Idle sessions auto-expire after 10 minutes.", {
    target,
    command: z.string().min(1),
    quiet_ms: z.number().int().min(100).max(5000).default(INTERACTIVE_QUIET_MS_DEFAULT).describe("How long output must be idle before returning."),
  }, handlers.ssh_interactive_exec);
  server.tool("ssh_interactive_input", "Send a line of input to a running ssh_interactive_exec session (e.g. answer a sudo password or y/N prompt), or just poll for more output if input is omitted. Returns newly produced output and status.", {
    session_id: z.string().min(1),
    input: z.string().optional().describe("Text to send. Omit to wait/poll for more output without sending anything."),
    newline: z.boolean().default(true).describe("Append a trailing newline after input (usually required for the remote program to see it as a submitted line)."),
    quiet_ms: z.number().int().min(100).max(5000).default(INTERACTIVE_QUIET_MS_DEFAULT),
  }, handlers.ssh_interactive_input);
  server.tool("ssh_interactive_close", "Kill and remove an interactive SSH session started with ssh_interactive_exec.", { session_id: z.string().min(1) }, handlers.ssh_interactive_close);
  server.tool("ssh_interactive_list", "List currently open interactive SSH sessions.", {}, handlers.ssh_interactive_list);
  server.tool("ssh_scp_to", "Upload a local file or directory to the remote host via scp (reuses the multiplexed SSH connection when mux is enabled).", {
    target,
    local_path: localPath,
    remote_path: path,
    recursive: z.boolean().default(false).describe("Required when local_path is a directory."),
    timeout_ms: z.number().int().min(1000).max(600000).default(120000),
  }, handlers.ssh_scp_to);
  server.tool("ssh_scp_from", "Download a remote file or directory to the local machine via scp (reuses the multiplexed SSH connection when mux is enabled).", {
    target,
    remote_path: path,
    local_path: localPath,
    recursive: z.boolean().default(false).describe("Required when remote_path is a directory."),
    timeout_ms: z.number().int().min(1000).max(600000).default(120000),
  }, handlers.ssh_scp_from);
  server.tool("ssh_close", "Close the multiplexed SSH master connection for a target (no-op when multiplexing is disabled, e.g. native Windows OpenSSH).", { target }, handlers.ssh_close);

  const pruneTimer = setInterval(pruneStaleSessions, 60000);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();

  function dispose() {
    clearInterval(pruneTimer);
    killAllInteractiveSessions();
    if (typeof transport.dispose === "function") transport.dispose();
  }

  return { server, handlers, interactiveSessions, dispose, pruneStaleSessions, killAllInteractiveSessions };
}
