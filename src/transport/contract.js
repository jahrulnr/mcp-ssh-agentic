/**
 * SSH transport contract — real and mock backends must implement this shape.
 *
 * Design goal: tool handlers call only this contract, never `spawn("ssh")` directly.
 * Unit tests inject `createMockTransport()` so behavior matches production without a real host.
 *
 * @typedef {object} CapturedResult
 * @property {Buffer} stdout
 * @property {Buffer} stderr
 * @property {number} code
 * @property {string|null} [signal]
 *
 * @typedef {object} ExecOptions
 * @property {string|Buffer} [stdin]
 * @property {number} [maxBytes]
 * @property {number} [timeoutMs]
 * @property {boolean} [allowNonZero]
 * @property {number[]} [okCodes]
 *
 * @typedef {object} ScpOptions
 * @property {"to"|"from"} direction
 * @property {string} localPath
 * @property {string} remotePath
 * @property {boolean} [recursive]
 * @property {number} [timeoutMs]
 *
 * @typedef {object} SshTransport
 * @property {(target: string, remoteCommand: string, opts?: ExecOptions) => Promise<CapturedResult>} exec
 *   Run a remote command string exactly as OpenSSH would receive after `ssh … -- <remoteCommand>`.
 * @property {(target: string, opts: ScpOptions) => Promise<CapturedResult>} scp
 * @property {(target: string) => Promise<CapturedResult>} close
 *   Drop multiplexed connection for target (real: `ssh -O exit`; mock: no-op success).
 * @property {(target: string, remoteCommand: string) => import('node:child_process').ChildProcess} spawnInteractive
 *   Spawn an interactive session with PTY-like stdio pipes (stdin/stdout/stderr).
 * @property {() => boolean} [getMuxEnabled]
 *   Whether ControlMaster multiplexing is currently enabled (real transport may flip this off after a Windows OpenSSH failure).
 * @property {() => void} [dispose]
 *   Optional cleanup (mock temp dirs, timers, open children).
 */

export {};
