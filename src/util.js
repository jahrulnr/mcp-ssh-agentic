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
 * Build an scp `user@host:path` spec that brackets IPv6 addresses.
 * OpenSSH `scp` requires `[user@host]:path` when the host contains colons.
 * @param {string} userHost as returned by parseTarget (e.g. "demo@host" or "demo@::1")
 * @param {string} remotePath
 */
export function scpRemoteSpec(userHost, remotePath) {
  const at = userHost.lastIndexOf("@");
  const user = at >= 0 ? userHost.slice(0, at + 1) : "";
  let host = at >= 0 ? userHost.slice(at + 1) : userHost;
  if (!host.startsWith("[") && !host.endsWith("]") && host.includes(":")) {
    host = `[${host}]`;
  }
  return `${user}${host}:${remotePath}`;
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
  return `if command -v bash >/dev/null 2>&1; then bash --noprofile --norc -c -- ${shellQuote(command)}; else sh -c -- ${shellQuote(command)}; fi`;
}

/**
 * List a remote directory with metadata in `ls -lAh` style.
 * `ls` is POSIX-ubiquitous, so this works on GNU, BSD/macOS, and busybox.
 * @param {string} path
 */
export function remoteListDirCommand(path) {
  return `LC_ALL=C ls -lAh -- ${shellQuote(path)}`;
}

/**
 * Read a remote text file with optional line offset/limit.
 * @param {string} path
 * @param {number} [offset] 1-based starting line (0 is treated as 1)
 * @param {number} [limit] number of lines; 0 means unlimited
 */
export function remoteReadFileCommand(path, offset = 1, limit = 0) {
  const p = shellQuote(path);
  const start = Math.max(1, Math.floor(offset || 1));
  if (start === 1 && limit === 0) return `cat -- ${p}`;
  if (start === 1) return `set -o pipefail; cat -- ${p} | head -n ${limit}`;
  if (limit === 0) return `cat -- ${p} | tail -n +${start}`;
  return `set -o pipefail; cat -- ${p} | tail -n +${start} | head -n ${limit}`;
}

/**
 * Build a ripgrep/grep remote command string.
 * @param {object} opts
 * @param {string} opts.pattern
 * @param {string} [opts.path]
 * @param {string} [opts.glob]
 * @param {boolean} [opts.ignoreCase]
 * @param {boolean} [opts.fixedStrings]
 * @param {boolean} [opts.wordRegexp]
 * @param {boolean} [opts.invert]
 * @param {number} [opts.maxResults]
 */
export function remoteGrepCommand({
  pattern,
  path = ".",
  glob,
  ignoreCase = false,
  fixedStrings = false,
  wordRegexp = false,
  invert = false,
  maxResults,
} = {}) {
  const qPattern = shellQuote(pattern);
  const qPath = shellQuote(path);
  const rgParts = ["--no-heading -n --hidden --no-messages"];
  const grepParts = ["-RIn --exclude-dir=.git --exclude-dir=node_modules"];
  if (glob) {
    rgParts.push(`--glob ${shellQuote(glob)}`);
    grepParts.push(`--include=${shellQuote(glob)}`);
  }
  if (ignoreCase) { rgParts.push("-i"); grepParts.push("-i"); }
  if (fixedStrings) { rgParts.push("-F"); grepParts.push("-F"); }
  if (wordRegexp) { rgParts.push("-w"); grepParts.push("-w"); }
  if (invert) { rgParts.push("-v"); grepParts.push("-v"); }
  if (maxResults) {
    const n = Number(maxResults);
    rgParts.push(`-m ${n}`);
    grepParts.push(`-m ${n}`);
  }
  rgParts.push("--");
  grepParts.push("--");
  return [
    "set +e",
    "if command -v rg >/dev/null 2>&1; then",
    `  out=$(rg ${rgParts.join(" ")} ${qPattern} ${qPath} 2>/dev/null)`,
    "  ec=$?",
    "else",
    `  out=$(grep ${grepParts.join(" ")} ${qPattern} ${qPath} 2>/dev/null)`,
    "  ec=$?",
    "fi",
    "printf '%s' \"$out\"",
    "if [ \"$ec\" -eq 0 ] || [ \"$ec\" -eq 1 ]; then exit 0; fi",
    "if [ -n \"$out\" ]; then exit 0; fi",
    "exit \"$ec\"",
  ].join("\n");
}

/**
 * Build a remote patch command supporting strip level and dry-run.
 * @param {object} opts
 * @param {number} [opts.strip]
 * @param {boolean} [opts.dry_run]
 */
export function remoteApplyPatchCommand({ strip = 0, dry_run = false } = {}) {
  const p = Number(strip) || 0;
  const header = [
    "tmpfile=$(mktemp)",
    "cat > \"$tmpfile\"",
  ];
  if (dry_run) {
    return [
      ...header,
      "if command -v git >/dev/null 2>&1; then",
      `  git apply --check -p${p} "$tmpfile" 2>/dev/null && { rm -f \"$tmpfile\"; exit 0; }`,
      "fi",
      "if command -v patch >/dev/null 2>&1; then",
      `  patch --dry-run -p${p} < "$tmpfile" 2>/dev/null && { rm -f \"$tmpfile\"; exit 0; }`,
      "fi",
      'rm -f "$tmpfile"',
      'echo "dry-run not supported: neither git apply --check nor patch --dry-run is available" >&2; exit 2',
    ].join("\n");
  }
  const lines = [...header];
  if (p === 0) {
    lines.push(
      "if command -v apply_patch >/dev/null 2>&1; then",
      '  apply_patch < "$tmpfile" && { rm -f "$tmpfile"; exit 0; }',
      "fi",
    );
  }
  lines.push(
    "if command -v git >/dev/null 2>&1; then",
    `  git apply -p${p} "$tmpfile" 2>/dev/null && { rm -f \"$tmpfile\"; exit 0; }`,
    "fi",
    "if command -v patch >/dev/null 2>&1; then",
    `  patch -p${p} < "$tmpfile" && { rm -f \"$tmpfile\"; exit 0; }`,
    "fi",
    'rm -f "$tmpfile"',
    '  echo "no patch tool found" >&2; exit 2',
  );
  return lines.join("\n");
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
