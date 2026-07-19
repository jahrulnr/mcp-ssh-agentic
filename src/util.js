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

export function controlPathFor(target, muxDir) {
  const parsed = parseTarget(target);
  const key = `${parsed.userHost}:${parsed.port || 22}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return join(muxDir, hash);
}

export function muxOptions(target, muxDir) {
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPathFor(target, muxDir)}`,
    "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
  ];
}

export function baseSshOptions(target, muxDir) {
  const parsed = parseTarget(target);
  return {
    parsed,
    args: [
      "-q",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      ...muxOptions(target, muxDir),
      ...(parsed.port ? ["-p", String(parsed.port)] : []),
    ],
  };
}

export function sshArgs(target, remoteCommand, muxDir) {
  const { parsed, args } = baseSshOptions(target, muxDir);
  return [...args, parsed.userHost, "--", remoteCommand];
}

export function interactiveSshArgs(target, remoteCommand, muxDir) {
  const { parsed, args } = baseSshOptions(target, muxDir);
  return [...args, "-tt", parsed.userHost, "--", remoteCommand];
}

export function isStaleMuxError(message) {
  return /Control socket|Connection refused|Mux|Master running|No such file or directory.*mux/i.test(message);
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
