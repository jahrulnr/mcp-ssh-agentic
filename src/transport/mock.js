import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MAX_TEXT_BYTES, formatFailure, parseTarget } from "../util.js";
import { spawnCaptured } from "./real.js";

/**
 * Resolve a remote path against the mock host root.
 * Absolute paths are treated as rooted under remoteRoot (sandbox), so `/etc/x`
 * becomes `<remoteRoot>/etc/x`.
 * @param {string} remoteRoot
 * @param {string} remotePath
 */
export function resolveRemotePath(remoteRoot, remotePath) {
  if (!remotePath) throw new Error("remote path is required");
  if (remotePath.includes("\0")) throw new Error("paths must not contain NUL");
  const cleaned = remotePath.replace(/^\/+/, "");
  const abs = resolve(remoteRoot, isAbsolute(remotePath) ? cleaned : remotePath);
  if (abs !== remoteRoot && !abs.startsWith(remoteRoot + "/") && !abs.startsWith(remoteRoot + "\\")) {
    throw new Error(`path escapes mock remote root: ${remotePath}`);
  }
  return abs;
}

/**
 * In-process SSH transport that executes the same remote command strings locally
 * under a sandboxed directory. At the contract boundary it matches real SSH
 * (`exec` / `scp` / `close` / `spawnInteractive`).
 *
 * Path convention for tests: pass paths relative to the mock root, or absolute
 * paths under `remoteRoot` (use `resolvePath("/etc/hostname")` → real abs path).
 * Commands run with `cwd=remoteRoot`, so relative paths behave like a remote home.
 *
 * @param {{ remoteRoot?: string, identity?: { uid?: string, hostname?: string } }} [options]
 * @returns {import('./contract.js').SshTransport & { remoteRoot: string, resolvePath: (p: string) => string, dispose: () => void }}
 */
export function createMockTransport({
  remoteRoot,
  identity = { uid: "1000", hostname: "mock-host" },
} = {}) {
  const ownedRoot = !remoteRoot;
  const root = remoteRoot || mkdtempSync(join(tmpdir(), "mcp-ssh-mock-"));
  mkdirSync(root, { recursive: true });

  // PATH shims so nested `bash --noprofile --norc -c …` (from remoteShellCommand)
  // still sees id/hostname — shell functions would not survive the inner bash.
  const binDir = join(root, ".mock-bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "id"), `#!/bin/sh\nif [ "$1" = "-u" ]; then printf '%s\\n' '${identity.uid}'; else command -p id "$@"; fi\n`);
  writeFileSync(join(binDir, "hostname"), `#!/bin/sh\nprintf '%s\\n' '${identity.hostname}'\n`);
  chmodSync(join(binDir, "id"), 0o755);
  chmodSync(join(binDir, "hostname"), 0o755);

  const env = {
    ...process.env,
    HOME: root,
    USER: "mock",
    LOGNAME: "mock",
    PATH: `${binDir}:${process.env.PATH || "/usr/bin:/bin"}`,
  };

  /**
   * OpenSSH runs `remoteCommand` as the remote argv. Production wraps tools with
   * remoteShellCommand (bash --noprofile --norc). We execute that exact string
   * under bash so quoting / non-login behavior matches production.
   */
  async function runRemote(remoteCommand, { stdin, maxBytes = MAX_TEXT_BYTES, timeoutMs = 30000 } = {}) {
    return spawnCaptured("bash", ["--noprofile", "--norc", "-c", remoteCommand], {
      stdin,
      maxBytes,
      timeoutMs,
      cwd: root,
      env,
    });
  }

  async function exec(target, remoteCommand, {
    stdin,
    maxBytes = MAX_TEXT_BYTES,
    timeoutMs = 30000,
    allowNonZero = false,
    okCodes = [],
  } = {}) {
    parseTarget(target);
    const result = await runRemote(remoteCommand, { stdin, maxBytes, timeoutMs });
    const successCodes = new Set([0, ...okCodes]);
    if (!allowNonZero && !successCodes.has(result.code)) {
      throw new Error(formatFailure(result));
    }
    return result;
  }

  async function scp(target, { direction, localPath, remotePath, recursive = false }) {
    parseTarget(target);
    if (!localPath || !remotePath) throw new Error("local_path and remote_path are required");
    if (localPath.includes("\0") || remotePath.includes("\0")) throw new Error("paths must not contain NUL");

    const remoteAbs = resolveRemotePath(root, remotePath);

    if (direction === "to") {
      if (!existsSync(localPath)) throw new Error(`local path does not exist: ${localPath}`);
      const st = statSync(localPath);
      if (st.isDirectory() && !recursive) throw new Error("local path is a directory; set recursive=true");
      if (!st.isDirectory() && !st.isFile()) throw new Error(`local path is not a regular file/directory: ${localPath}`);
      mkdirSync(dirname(remoteAbs), { recursive: true });
      if (st.isDirectory()) cpSync(localPath, remoteAbs, { recursive: true });
      else copyFileSync(localPath, remoteAbs);
    } else if (direction === "from") {
      if (!existsSync(remoteAbs)) {
        throw new Error(formatFailure({
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(`scp: ${remotePath}: No such file or directory\n`),
        }));
      }
      mkdirSync(dirname(localPath), { recursive: true });
      const st = statSync(remoteAbs);
      if (st.isDirectory()) {
        if (!recursive) throw new Error("remote path is a directory; set recursive=true");
        cpSync(remoteAbs, localPath, { recursive: true });
      } else {
        copyFileSync(remoteAbs, localPath);
      }
    } else {
      throw new Error('direction must be "to" (upload) or "from" (download)');
    }

    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0, signal: null };
  }

  async function close(target) {
    parseTarget(target);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0, signal: null };
  }

  function spawnInteractive(target, remoteCommand) {
    parseTarget(target);
    // detached so we can signal the whole process group (nested bash/sleep) on close
    return spawn("bash", ["--noprofile", "--norc", "-c", remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: root,
      env,
      detached: true,
    });
  }

  function dispose() {
    if (ownedRoot) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  return {
    remoteRoot: root,
    exec,
    scp,
    close,
    spawnInteractive,
    getMuxEnabled: () => true,
    dispose,
    resolvePath: (p) => resolveRemotePath(root, p),
  };
}
