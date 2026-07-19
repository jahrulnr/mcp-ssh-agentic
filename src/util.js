import { createHash } from "node:crypto";
import { join } from "node:path";

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const CONTROL_PERSIST_SECONDS = 600;

export const INTERACTIVE_QUIET_MS_DEFAULT = 500;
export const INTERACTIVE_MAX_WAIT_MS = 15000;
export const INTERACTIVE_SESSION_TTL_MS = 10 * 60 * 1000;
export const INTERACTIVE_MAX_SESSIONS = 8;
export const INTERACTIVE_MAX_BUFFER_BYTES = MAX_TEXT_BYTES;

/**
 * Whether OpenSSH ControlMaster multiplexing should be used.
 *
 * Native Win32-OpenSSH (the client used from cmd.exe, PowerShell, and typically
 * Git Bash when `ssh` resolves to System32/OpenSSH) does not support ControlMaster
 * — it fails with errors like "getsockname failed: Not a socket".
 *
 * Override with env `MCP_SSH_AGENTIC_MUX=0|1` (also true/false/yes/no/on/off).
 * WSL is `platform=linux` and keeps mux enabled.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveMuxEnabled({ platform = process.platform, env = process.env } = {}) {
  const raw = env.MCP_SSH_AGENTIC_MUX;
  if (raw !== undefined && String(raw).trim() !== "") {
    const v = String(raw).trim();
    if (/^(0|false|no|off)$/i.test(v)) return false;
    if (/^(1|true|yes|on)$/i.test(v)) return true;
  }
  return platform !== "win32";
}

/**
 * Best-effort label for the local client environment (docs / instructions).
 * Cursor launches Node directly, so shell is often "windows" even if the user
 * normally works in PowerShell or Git Bash — all three share win32 + Win32-OpenSSH.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {"linux"|"darwin"|"windows-cmd"|"windows-powershell"|"windows-git-bash"|"windows"|"other"}
 */
export function describeLocalClient({ platform = process.platform, env = process.env } = {}) {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform !== "win32") return "other";

  // Heuristics only — Cursor/MCP usually spawn Node directly, not via the user's shell.
  if (
    env.MSYSTEM
    || /\bbash\.exe\b/i.test(env.SHELL || "")
    || /\\Git\\/i.test(env.EXEPATH || "")
  ) {
    return "windows-git-bash";
  }
  if (env.POWERSHELL_DISTRIBUTION_CHANNEL || env.PSExecutionPolicyPreference !== undefined) {
    return "windows-powershell";
  }
  if (/\bcmd\.exe\b/i.test(env.ComSpec || "")) return "windows-cmd";
  return "windows";
}

/**
 * @param {string} value
 * @returns {{ userHost: string, port?: number }}
 */
export function parseTarget(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("target is required");
  const target = value.trim();
  let userHost = target;
  let port;
  const match = target.match(/^(.*)@\[([^\]]+)\]:(\d+)$/) || target.match(/^(.*)@([^:]+):(\d+)$/);
  if (match) {
    userHost = `${match[1]}@${match[2]}`;
    port = Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid SSH port");
  }
  if (!userHost.includes("@")) throw new Error("target must look like user@host[:port]");
  return { userHost, port };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} target
 * @param {string} muxDir
 * @param {{ platform?: NodeJS.Platform }} [opts]
 */
export function controlPathFor(target, muxDir, { platform = process.platform } = {}) {
  const parsed = parseTarget(target);
  const key = `${parsed.userHost}:${parsed.port || 22}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const path = join(muxDir, hash);
  // OpenSSH ControlPath is happier with forward slashes even when forced on Windows.
  return platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/**
 * @param {string} target
 * @param {string} muxDir
 * @param {{ enabled?: boolean }} [opts]
 */
export function muxOptions(target, muxDir, { enabled = true } = {}) {
  if (!enabled) return [];
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPathFor(target, muxDir)}`,
    "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
  ];
}

/**
 * @param {string} target
 * @param {string} muxDir
 * @param {{ muxEnabled?: boolean }} [opts]
 */
export function baseSshOptions(target, muxDir, { muxEnabled = true } = {}) {
  const parsed = parseTarget(target);
  return {
    parsed,
    args: [
      "-q",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      ...muxOptions(target, muxDir, { enabled: muxEnabled }),
      ...(parsed.port ? ["-p", String(parsed.port)] : []),
    ],
  };
}

/**
 * @param {string} target
 * @param {string} remoteCommand
 * @param {string} muxDir
 * @param {{ muxEnabled?: boolean }} [opts]
 */
export function sshArgs(target, remoteCommand, muxDir, opts = {}) {
  const { parsed, args } = baseSshOptions(target, muxDir, opts);
  return [...args, parsed.userHost, "--", remoteCommand];
}

/**
 * @param {string} target
 * @param {string} remoteCommand
 * @param {string} muxDir
 * @param {{ muxEnabled?: boolean }} [opts]
 */
export function interactiveSshArgs(target, remoteCommand, muxDir, opts = {}) {
  const { parsed, args } = baseSshOptions(target, muxDir, opts);
  return [...args, "-tt", parsed.userHost, "--", remoteCommand];
}

export function isStaleMuxError(message) {
  return /Control socket|Connection refused|Mux|Master running|No such file or directory.*mux/i.test(message);
}

/** Errors that mean this SSH client cannot use ControlMaster at all. */
export function isMuxUnsupportedError(message) {
  return /getsockname failed|Not a socket|Bad file descriptor|muxserver_listen|unsupported multiplexing/i.test(message);
}

export function decodeUtf8(buffer) {
  return buffer.toString("utf8");
}

export function formatFailure(result) {
  const code = result.code ?? 1;
  const stderr = decodeUtf8(result.stderr).trim();
  const stdout = decodeUtf8(result.stdout).trim();
  const parts = [`SSH exited with code ${code}`];
  if (stderr) parts.push(stderr);
  if (stdout) parts.push(stdout);
  return parts.join("\n");
}

export function textResult(text, { isError = false } = {}) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

export function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

export async function safe(fn) {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}

export function combineStreams(stdout, stderr) {
  const out = stdout.endsWith("\n") || stdout.length === 0 ? stdout : `${stdout}\n`;
  const err = stderr.trim();
  if (!err) return out;
  if (!out) return stderr.endsWith("\n") ? stderr : `${stderr}\n`;
  return `${out}[stderr]\n${stderr.endsWith("\n") ? stderr : `${stderr}\n`}`;
}

/** Non-login shell so broken /etc/profile.d scripts cannot abort the command. */
export function remoteShellCommand(command) {
  return `if command -v bash >/dev/null 2>&1; then bash --noprofile --norc -c ${shellQuote(command)}; else sh -c ${shellQuote(command)}; fi`;
}

/**
 * List a remote directory with type/size/mtime/path.
 * Uses GNU find -printf when available; otherwise a BSD/POSIX-friendly fallback
 * (needed for macOS clients running the mock transport, and macOS remotes).
 * @param {string} path
 */
export function remoteListDirCommand(path) {
  const p = shellQuote(path);
  return [
    "set -e",
    `path=${p}`,
    "if find --version >/dev/null 2>&1; then",
    "  find \"$path\" -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%TY-%Tm-%Td %TH:%TM:%TS\\t%p\\n' | sort",
    "else",
    "  find \"$path\" -maxdepth 1 -mindepth 1 | sort | while IFS= read -r entry; do",
    "    if [ -L \"$entry\" ]; then t=l",
    "    elif [ -d \"$entry\" ]; then t=d",
    "    elif [ -f \"$entry\" ]; then t=f",
    "    elif [ -b \"$entry\" ]; then t=b",
    "    elif [ -c \"$entry\" ]; then t=c",
    "    elif [ -p \"$entry\" ]; then t=p",
    "    elif [ -S \"$entry\" ]; then t=s",
    "    else t=u",
    "    fi",
    "    if [ -f \"$entry\" ] && [ ! -L \"$entry\" ]; then",
    "      s=$(wc -c < \"$entry\" | tr -d '[:space:]')",
    "    else",
    "      s=0",
    "    fi",
    "    m=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' \"$entry\" 2>/dev/null || true)",
    "    if [ -z \"$m\" ]; then",
    "      m=$(stat -c '%y' \"$entry\" 2>/dev/null | cut -c1-19 || echo '?')",
    "    fi",
    "    printf '%s\\t%s\\t%s\\t%s\\n' \"$t\" \"$s\" \"$m\" \"$entry\"",
    "  done",
    "fi",
  ].join("\n");
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function appendToSessionBuffer(session, chunk, maxBytes = INTERACTIVE_MAX_BUFFER_BYTES) {
  session.chunks.push(chunk);
  session.bufferedBytes += chunk.length;
  while (session.bufferedBytes > maxBytes && session.chunks.length > 1) {
    session.truncated = true;
    const dropped = session.chunks.shift();
    session.bufferedBytes -= dropped.length;
  }
}

export function drainSessionOutput(session) {
  const text = Buffer.concat(session.chunks).toString("utf8");
  session.chunks = [];
  session.bufferedBytes = 0;
  const truncated = session.truncated;
  session.truncated = false;
  return { text, truncated };
}

/** Resolve once output has gone quiet, the process exits, or maxWaitMs elapses. */
export function settleSession(session, { quietMs = INTERACTIVE_QUIET_MS_DEFAULT, maxWaitMs = INTERACTIVE_MAX_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (session.exited) return resolve();
      const now = Date.now();
      if (now - session.lastDataAt >= quietMs) return resolve();
      if (now - start >= maxWaitMs) return resolve();
      setTimeout(check, 50);
    };
    check();
  });
}
