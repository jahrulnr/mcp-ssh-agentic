import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  MAX_TEXT_BYTES,
  baseSshOptions,
  controlPathFor,
  decodeUtf8,
  formatFailure,
  interactiveSshArgs,
  isStaleMuxError,
  muxOptions,
  parseTarget,
  sshArgs,
} from "../util.js";

function clearControlSocket(target, muxDir) {
  const path = controlPathFor(target, muxDir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ stdin?: string|Buffer, maxBytes?: number, timeoutMs?: number, cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<import('./contract.js').CapturedResult>}
 */
export function spawnCaptured(command, args, {
  stdin,
  maxBytes = MAX_TEXT_BYTES,
  timeoutMs = 30000,
  cwd,
  env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (size > maxBytes) return reject(new Error(`remote output exceeded ${maxBytes} bytes`));
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1, signal });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

/**
 * Real transport: local `ssh` / `scp` binaries + ControlMaster mux.
 * @param {{ muxDir: string }} options
 * @returns {import('./contract.js').SshTransport}
 */
export function createRealTransport({ muxDir }) {
  mkdirSync(muxDir, { recursive: true });

  async function exec(target, remoteCommand, {
    stdin,
    maxBytes = MAX_TEXT_BYTES,
    timeoutMs = 30000,
    allowNonZero = false,
    okCodes = [],
  } = {}) {
    const attempt = async () => spawnCaptured("ssh", sshArgs(target, remoteCommand, muxDir), { stdin, maxBytes, timeoutMs });
    let result = await attempt();
    if (result.code !== 0 && isStaleMuxError(decodeUtf8(result.stderr))) {
      clearControlSocket(target, muxDir);
      result = await attempt();
    }
    const successCodes = new Set([0, ...okCodes]);
    if (!allowNonZero && !successCodes.has(result.code)) {
      throw new Error(formatFailure(result));
    }
    return result;
  }

  async function scp(target, { direction, localPath, remotePath, recursive = false, timeoutMs = 120000 }) {
    if (!localPath || !remotePath) throw new Error("local_path and remote_path are required");
    if (localPath.includes("\0") || remotePath.includes("\0")) throw new Error("paths must not contain NUL");

    const parsed = parseTarget(target);
    const remoteSpec = `${parsed.userHost}:${remotePath}`;
    const args = [
      "-q",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      ...muxOptions(target, muxDir),
      ...(parsed.port ? ["-P", String(parsed.port)] : []),
      ...(recursive ? ["-r"] : []),
    ];

    if (direction === "to") {
      if (!existsSync(localPath)) throw new Error(`local path does not exist: ${localPath}`);
      const st = statSync(localPath);
      if (st.isDirectory() && !recursive) throw new Error("local path is a directory; set recursive=true");
      if (!st.isDirectory() && !st.isFile()) throw new Error(`local path is not a regular file/directory: ${localPath}`);
      args.push(localPath, remoteSpec);
    } else if (direction === "from") {
      mkdirSync(dirname(localPath), { recursive: true });
      args.push(remoteSpec, localPath);
    } else {
      throw new Error('direction must be "to" (upload) or "from" (download)');
    }

    const attempt = async () => spawnCaptured("scp", args, { timeoutMs, maxBytes: MAX_TEXT_BYTES });
    let result = await attempt();
    if (result.code !== 0 && isStaleMuxError(decodeUtf8(result.stderr))) {
      clearControlSocket(target, muxDir);
      result = await attempt();
    }
    if (result.code !== 0) throw new Error(formatFailure(result));
    return result;
  }

  async function close(target) {
    const { parsed, args } = baseSshOptions(target, muxDir);
    const result = await spawnCaptured("ssh", [...args, "-O", "exit", parsed.userHost], { timeoutMs: 10000 });
    clearControlSocket(target, muxDir);
    return result;
  }

  function spawnInteractive(target, remoteCommand) {
    return spawn("ssh", interactiveSshArgs(target, remoteCommand, muxDir), { stdio: ["pipe", "pipe", "pipe"] });
  }

  return { exec, scp, close, spawnInteractive };
}
