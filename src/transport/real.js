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
  isMuxUnsupportedError,
  isStaleMuxError,
  muxOptions,
  parseTarget,
  resolveMuxEnabled,
  scpRemoteSpec,
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
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= maxBytes) stderr.push(chunk);
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (stdoutSize > maxBytes) return reject(new Error(`remote output exceeded ${maxBytes} bytes`));
      if (stderrSize > maxBytes) return reject(new Error(`remote stderr output exceeded ${maxBytes} bytes`));
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1, signal });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

/**
 * Real transport: local `ssh` / `scp` binaries + optional ControlMaster mux.
 * Mux is off by default on Windows (cmd / PowerShell / Git Bash + Win32-OpenSSH).
 * @param {{ muxDir: string, muxEnabled?: boolean }} options
 * @returns {import('./contract.js').SshTransport & { getMuxEnabled: () => boolean }}
 */
export function createRealTransport({ muxDir, muxEnabled: muxEnabledOption } = {}) {
  mkdirSync(muxDir, { recursive: true });
  let muxEnabled = muxEnabledOption ?? resolveMuxEnabled();
  const muxOpts = () => ({ muxEnabled });

  async function exec(target, remoteCommand, {
    stdin,
    maxBytes = MAX_TEXT_BYTES,
    timeoutMs = 30000,
    allowNonZero = false,
    okCodes = [],
  } = {}) {
    const attempt = async () => spawnCaptured("ssh", sshArgs(target, remoteCommand, muxDir, muxOpts()), { stdin, maxBytes, timeoutMs });
    let result = await attempt();
    if (result.code !== 0 && muxEnabled && isMuxUnsupportedError(decodeUtf8(result.stderr))) {
      muxEnabled = false;
      result = await attempt();
    } else if (result.code !== 0 && muxEnabled && isStaleMuxError(decodeUtf8(result.stderr))) {
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
    const remoteSpec = scpRemoteSpec(parsed.userHost, remotePath);

    const buildArgs = () => {
      const args = [
        "-q",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        ...muxOptions(target, muxDir, { enabled: muxEnabled }),
        ...(parsed.port ? ["-P", String(parsed.port)] : []),
        ...(recursive ? ["-r"] : []),
      ];
      if (direction === "to") {
        args.push(localPath, remoteSpec);
      } else if (direction === "from") {
        args.push(remoteSpec, localPath);
      } else {
        throw new Error('direction must be "to" (upload) or "from" (download)');
      }
      return args;
    };

    if (direction === "to") {
      if (!existsSync(localPath)) throw new Error(`local path does not exist: ${localPath}`);
      const st = statSync(localPath);
      if (st.isDirectory() && !recursive) throw new Error("local path is a directory; set recursive=true");
      if (!st.isDirectory() && !st.isFile()) throw new Error(`local path is not a regular file/directory: ${localPath}`);
    } else if (direction === "from") {
      mkdirSync(dirname(localPath), { recursive: true });
    } else {
      throw new Error('direction must be "to" (upload) or "from" (download)');
    }

    const attempt = async () => spawnCaptured("scp", buildArgs(), { timeoutMs, maxBytes: MAX_TEXT_BYTES });
    let result = await attempt();
    if (result.code !== 0 && muxEnabled && isMuxUnsupportedError(decodeUtf8(result.stderr))) {
      muxEnabled = false;
      result = await attempt();
    } else if (result.code !== 0 && muxEnabled && isStaleMuxError(decodeUtf8(result.stderr))) {
      clearControlSocket(target, muxDir);
      result = await attempt();
    }
    if (result.code !== 0) throw new Error(formatFailure(result));
    return result;
  }

  async function close(target) {
    if (!muxEnabled) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("multiplexing disabled\n"), code: 0, signal: null };
    }
    const { parsed, args } = baseSshOptions(target, muxDir, muxOpts());
    const result = await spawnCaptured("ssh", [...args, "-O", "exit", parsed.userHost], { timeoutMs: 10000 });
    clearControlSocket(target, muxDir);
    return result;
  }

  function spawnInteractive(target, remoteCommand) {
    return spawn("ssh", interactiveSshArgs(target, remoteCommand, muxDir, muxOpts()), { stdio: ["pipe", "pipe", "pipe"] });
  }

  return {
    exec,
    scp,
    close,
    spawnInteractive,
    getMuxEnabled: () => muxEnabled,
  };
}
