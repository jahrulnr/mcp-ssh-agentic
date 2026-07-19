# mcp-ssh-agentic

An MCP server for agentic SSH/SCP operations with passwordless authentication. It uses the operating system's native `ssh` and `scp` binaries, so existing SSH features continue to work seamlessly, including public key authentication, `~/.ssh/config`, `ssh-agent`, `ProxyJump`, and `known_hosts`.

## Connection Efficiency

Each target uses **SSH ControlMaster** multiplexing:

- Socket: `~/.cache/mcp-ssh-agentic/mux/<hash>`
- `ControlPersist=600` (master connection stays alive for 10 minutes of idle time)
- Subsequent calls to the same host reuse the existing TCP connection and authentication, making operations much faster than opening a new SSH connection for every tool call.
- Stale sockets are automatically removed and the connection is retried once.
- `ssh_close` explicitly closes the master connection.

## Running with npx

After a release, the package is on **npmjs** and **GitHub Packages** as `@jahrulnr/mcp-ssh-agentic`.

**npmjs (simplest):**

```json
{
  "mcpServers": {
    "ssh-agentic": {
      "command": "npx",
      "args": ["-y", "@jahrulnr/mcp-ssh-agentic"]
    }
  }
}
```

**GitHub Packages** (needs a PAT with `read:packages` in `~/.npmrc`):

```ini
@jahrulnr:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

```json
{
  "mcpServers": {
    "ssh-agentic": {
      "command": "npx",
      "args": ["-y", "--registry=https://npm.pkg.github.com", "@jahrulnr/mcp-ssh-agentic"]
    }
  }
}
```

Targets must always be specified as `user@host[:port]`, for example `demo@127.0.0.1:22`. The port may also be configured through aliases in `~/.ssh/config`.

## Available Tools

`ssh_ping`, `ssh_read_file`, `ssh_write_file`, `ssh_read_image`, `ssh_list_dir`, `ssh_mkdir`, `ssh_grep`, `ssh_apply_patch`, `ssh_delete`, `ssh_exec`, `ssh_interactive_exec`, `ssh_interactive_input`, `ssh_interactive_close`, `ssh_interactive_list`, `ssh_scp_to`, `ssh_scp_from`, `ssh_close`

Examples:

```text
ssh_read_file("demo@127.0.0.1:22", "/etc/hostname")
ssh_write_file("demo@server", "/srv/app/.env", "PORT=3000\n")
ssh_mkdir("demo@server", "/srv/app/releases/42")
ssh_list_dir("demo@server", "/var/log")
ssh_grep("demo@server", "TODO", "/srv/app", "*.js")
ssh_exec("demo@server", "systemctl --user status my-service")

# Commands that may require interactive input (sudo password, y/N prompts, setup wizards):
ssh_interactive_exec("demo@server", "sudo apt-get upgrade")
# -> session_id=abc123, status=running, output contains "[sudo] password for demo:"
ssh_interactive_input(session_id="abc123", input="secret123")
# -> additional output, e.g. "Do you want to continue? [Y/n]"
ssh_interactive_input(session_id="abc123", input="Y")
# -> status=exited (code 0) once the process finishes
ssh_interactive_close("abc123")  # close manually if needed

ssh_scp_to("demo@server", "./dist/app.tar.gz", "/apps/app.tar.gz")
ssh_scp_from("demo@server", "/apps/backups/db.sql.gz", "./db.sql.gz")
ssh_close("demo@server")
```

## Behavior Notes

- `ssh_delete` uses `rm -f` for files and `rm -rf` only when `recursive=true`.
- `ssh_write_file` writes or overwrites a remote file directly from text (without creating a temporary local file). Use `append=true` to append instead of overwrite. Parent directories are created automatically unless `create_dirs=false`.
- `ssh_mkdir` is equivalent to `mkdir -p` on the remote host, which is especially useful before `ssh_scp_to`, since `scp` does not automatically create remote parent directories.
- `ssh_exec` has a default timeout of 30 seconds and a maximum output size of 5 MiB. `ssh_read_image` supports files up to 20 MiB. `ssh_write_file` accepts content up to 5 MiB. SCP operations default to a 120-second timeout.
- All remote commands (not just `ssh_exec`) run through a **non-login, non-interactive shell** (`bash --noprofile --norc -c`, falling back to `sh -c`). This avoids failures caused by broken `/etc/profile.d` scripts on some servers and ensures consistent behavior across all tools. `ssh_exec` always returns `exit_code=N` along with stdout. If stderr is present, it is included in a `[stderr]` section. Non-zero exit codes set `isError`, but stdout is still returned.
- **Interactive sessions (TTY/PTY):** `ssh_interactive_exec` forces PTY allocation on the remote side (`ssh -tt`), allowing programs that require a real terminal (`sudo`, `passwd`, confirmation prompts, setup wizards, REPLs, etc.) to behave correctly even though the local side uses ordinary pipes. The server waits until output has been quiet for `quiet_ms` (default: 500 ms) or the process exits, then returns the collected output along with a `session_id`. Continue the session using `ssh_interactive_input` (leave `input` empty to simply wait for more output without sending anything). This mechanism is based on output inactivity rather than prompt detection. Commands that continuously produce output (such as long build logs) may cause the tool call to wait longer depending on `quiet_ms` and `maxWaitMs`. The server allows up to 8 concurrent interactive sessions, automatically cleans up sessions after 10 minutes of inactivity, and terminates all active sessions when the server exits. Use `ssh_interactive_list` to view active sessions and `ssh_interactive_close` to close them manually.
- `ssh_grep` treats "no matches" as a successful result and still returns partial matches even if some paths cannot be read.
- `ssh_scp_to` and `ssh_scp_from` support `recursive=true` for directories. Local parent directories are created automatically when downloading. Remote parent directories must already exist before uploading (use `ssh_mkdir` if needed).
- The SSH and SCP clients are invoked with `-q` to suppress MOTD and other unnecessary output on stderr.

## Local Development

```bash
npm install
npm run check
npm test
npm start
```

Unit tests use `createMockTransport()` — the same SSH contract (`exec` / `scp` / `close` / `spawnInteractive`) executed in a local sandbox, without a real SSH host.

To test the MCP protocol, use MCP Inspector or any MCP client that supports stdio transport.

## CI / Release

GitHub Actions (`.github/workflows/ci.yml`):

1. **Unit test** (any branch/PR) — Node 18 / 22 / 24 → `npm run check` + `npm run test:unit`
2. **MCP test** (after unit) — same Node matrix × (`node` bin | `npx` from `npm pack`) with `MCP_SSH_AGENTIC_MOCK=1`
3. **Push to `master`** — after both pass, if tag `vX.Y.Z` is new: create tag → publish to GitHub Packages + npmjs

Local: `npm run test:all`

Bump `version` in `package.json` before merging to `master` for a new release. Re-merging the same version skips tag/publish.

**Secrets:** `NPM_TOKEN`. GitHub Packages uses `GITHUB_TOKEN` (`packages: write`).
