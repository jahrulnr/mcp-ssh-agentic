# mcp-ssh-agentic

MCP server untuk operasi agentic melalui SSH/SCP passwordless. Server menggunakan binary `ssh`/`scp` dari OS, sehingga autentikasi public key, `~/.ssh/config`, `ssh-agent`, `ProxyJump`, dan `known_hosts` tetap digunakan.

## Efisiensi koneksi

Di **Linux** dan **macOS**, setiap target memakai **SSH ControlMaster** multiplexing:

- Socket: `~/.cache/mcp-ssh-agentic/mux/<hash>`
- `ControlPersist=600` (master tetap hidup 10 menit idle)
- Call berikutnya ke host yang sama memakai ulang TCP/auth — jauh lebih cepat daripada open/close per tool call
- Socket stale otomatis dibersihkan + di-retry sekali
- `ssh_close` menutup master secara eksplisit

### Windows (cmd / PowerShell / Git Bash)

**Win32-OpenSSH** native **tidak mendukung** ControlMaster (berlaku untuk ketiga shell Windows umum — mereka memakai `ssh.exe` yang sama). Multiplexing **dimatikan by default** di `win32`; setiap tool call membuka koneksi SSH baru. Fitur lain tetap sama.

| Client | Mux default | Catatan |
|---|---|---|
| Windows cmd.exe | off | Win32-OpenSSH |
| Windows PowerShell / pwsh | off | Client OpenSSH yang sama |
| Git Bash | off | Biasanya Win32-OpenSSH di `PATH` |
| WSL | on | Berjalan sebagai Linux — disarankan di Windows untuk reuse koneksi |
| macOS / Linux | on | ControlMaster penuh |

Jika error ControlMaster tetap muncul (misalnya setelah memaksa mux), server mematikan multiplexing untuk sisa proses dan mencoba ulang tanpa mux.

Override lewat env `MCP_SSH_AGENTIC_MUX=0|1` (juga `true`/`false`/`yes`/`no`/`on`/`off`).

## Menjalankan dengan npx

Setelah rilis, package ada di **npmjs** dan **GitHub Packages** sebagai `@jahrulnr/mcp-ssh-agentic`.

**npmjs (paling sederhana):**

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

**GitHub Packages** (butuh PAT `read:packages` di `~/.npmrc`):

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

Target selalu berformat `user@host[:port]`, contoh `demo@127.0.0.1:22`. Port juga dapat dikelola lewat alias di `~/.ssh/config`.

## Tools

`ssh_ping`, `ssh_read_file`, `ssh_write_file`, `ssh_read_image`, `ssh_list_dir`, `ssh_mkdir`, `ssh_grep`, `ssh_apply_patch`, `ssh_delete`, `ssh_exec`, `ssh_exec_result`, `ssh_exec_kill`, `ssh_interactive_exec`, `ssh_interactive_input`, `ssh_interactive_close`, `ssh_interactive_list`, `ssh_scp_to`, `ssh_scp_from`, `ssh_close`

Contoh:

```text
ssh_read_file("demo@127.0.0.1:22", "/etc/hostname")
ssh_write_file("demo@server", "/srv/app/.env", "PORT=3000\n")
ssh_mkdir("demo@server", "/srv/app/releases/42")
ssh_list_dir("demo@server", "/var/log")
ssh_grep("demo@server", "TODO", "/srv/app", "*.js")
ssh_exec("demo@server", "systemctl --user status my-service")

# Perintah lama / background:
ssh_exec("demo@server", "./build.sh", background=true)
# -> job_id=abc123
ssh_exec_result(job_id="abc123", wait=true, timeout_ms=60000)
ssh_exec_kill(job_id="abc123", signal="SIGTERM", cleanup=true)

# Perintah yang mungkin minta input interaktif (sudo password, y/N, wizard):
ssh_interactive_exec("demo@server", "sudo apt-get upgrade")
# -> session_id=abc123, status=running, output berisi "[sudo] password for demo:"
ssh_interactive_input(session_id="abc123", input="rahasia123")
# -> output lanjutan, mis. "Do you want to continue? [Y/n]"
ssh_interactive_input(session_id="abc123", input="Y")
# -> status=exited (code 0) begitu proses selesai
ssh_interactive_close("abc123")  # jaga-jaga kalau lupa/berhenti di tengah

ssh_scp_to("demo@server", "./dist/app.tar.gz", "/apps/app.tar.gz")
ssh_scp_from("demo@server", "/apps/backups/db.sql.gz", "./db.sql.gz")
ssh_close("demo@server")
```

## Catatan perilaku

- `ssh_delete` memakai `rm -f` untuk file dan `rm -rf` hanya jika `recursive=true`.
- `ssh_write_file` menulis/menimpa file remote langsung dari teks (tanpa file lokal perantara); `append=true` untuk menambahkan; parent directory dibuat otomatis kecuali `create_dirs=false`.
- `ssh_mkdir` setara `mkdir -p` di remote — berguna sebelum `ssh_scp_to` karena scp tidak membuat parent directory remote secara otomatis.
- `ssh_exec` timeout default 30s, output max 5 MiB; `ssh_read_image` max 20 MiB; `ssh_write_file` konten max 5 MiB; SCP timeout default 120s. `ssh_exec` juga menerima `cwd`, `env`, `ok_codes`, dan `max_output_bytes`.
- Set `background=true` di `ssh_exec` untuk menjalankan perintah detached dan mendapat `job_id`. Gunakan `ssh_exec_result` untuk poll atau menunggu, dan `ssh_exec_kill` untuk menghentikan atau membersihkan direktori log job.
- Semua command remote (bukan hanya `ssh_exec`) dijalankan lewat shell **non-login non-interaktif** (`bash --noprofile --norc -c`, fallback `sh -c`) supaya `/etc/profile.d` yang rusak di beberapa VPS tidak membatalkan command apa pun — konsisten di seluruh tools. `ssh_exec` merespons `exit_code=N` + stdout; stderr di blok `[stderr]` bila ada. Exit non-zero men-set `isError` tetapi stdout tetap dikembalikan.
- **Sesi interaktif (TTY/PTY):** `ssh_interactive_exec` memaksa alokasi PTY di sisi remote (`ssh -tt`) sehingga program yang mengecek `isatty()` (sudo, `passwd`, konfirmasi `y/N`, wizard, REPL) tetap berperilaku interaktif walau sisi lokal tetap pipe biasa. Server menunggu sampai output "diam" selama `quiet_ms` (default 500ms) atau proses selesai, lalu mengembalikan output yang terkumpul + `session_id`. Balas atau poll lewat `ssh_interactive_input` (kosongkan `input` untuk sekadar menunggu output tambahan tanpa mengirim apa pun). Ini heuristik berbasis jeda output, bukan pendeteksian prompt yang presisi — untuk perintah yang memang terus-menerus menghasilkan output tanpa jeda (build log panjang, misalnya), `quiet_ms`/`maxWaitMs` bisa membuat tool call terasa lama menunggu. Sesi dibatasi maksimal 8 bersamaan, otomatis dibersihkan setelah 10 menit tanpa aktivitas, dan seluruh sesi aktif dimatikan saat proses server berhenti. Gunakan `ssh_interactive_list` untuk melihat sesi yang masih terbuka dan `ssh_interactive_close` untuk menutup manual.
- `ssh_grep` memperlakukan "no matches" sebagai sukses dan tetap mengembalikan hit parsial bila sebagian path tidak terbaca.
- `ssh_scp_to` / `ssh_scp_from`: set `recursive=true` untuk direktori. Parent directory lokal untuk download dibuat otomatis; parent remote untuk upload harus sudah ada (pakai `ssh_mkdir` dulu bila perlu).
- Client SSH/SCP memakai `-q` agar MOTD tidak mengotori stderr.

## Pengembangan lokal

```bash
npm install
npm run check
npm test
npm start
```

Unit test memakai `createMockTransport()` — kontrak SSH yang sama di sandbox lokal, tanpa host SSH sungguhan.

Untuk menguji protokol MCP, gunakan MCP Inspector atau client MCP yang mendukung transport stdio.

## CI / Release

GitHub Actions (`.github/workflows/ci.yml`):

1. **Unit test** — Node 18 / 22 / 24
2. **MCP test** — matrix Node × (`node` | `npx` dari tarball) dengan `MCP_SSH_AGENTIC_MOCK=1`
3. **Push ke `master`** — tag + publish ke GitHub Packages dan npmjs

Lokal: `npm run test:all`. Secret: `NPM_TOKEN`.
