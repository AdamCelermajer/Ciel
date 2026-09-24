# CIEL

Your code, everywhere. A personal PWA for coding sessions that run on the computer you select. Projects, conversations, models, credentials, skills and work stay on that computer. Switching hosts replaces the whole visible workspace; running tasks continue on their original host.

## Development

Requires Node.js 24 LTS and pnpm 11. `pnpm install`, then `pnpm dev`. Open the Vite URL printed in the console. For the bundled service, run `pnpm build && pnpm start` and open http://127.0.0.1:4317.

`pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` run checks. Production never uses the deterministic test adapter.

## Install

Run `pnpm build && pnpm package all` to create Linux and Windows bundles with an official, checksum-verified Node.js 24 runtime. Linux packaging requires `rpmbuild`, `tar`, `zip`, and `unzip` for both platforms. Build output is in `releases/`.

- Fedora: install the RPM and launch CIEL, or extract the Linux tarball and run `setup/install.sh` for installation to your user account without root. A systemd user service starts silently after sign-in. The CIEL launcher opens a native GTK window when Python GObject and WebKitGTK 4.1 are present; otherwise it opens the browser.
- Windows: compile the payload zip into a GUI installer with `setup/build-installer.ps1 -Payload <zip> -Output <setup.exe>` on Windows. The installer uses your local app-data directory and a hidden sign-in launcher. No administrator access or persistent terminal window is required.

CIEL data is separate from the application: `$XDG_DATA_HOME/ciel` (normally `~/.local/share/ciel`) on Linux; `%LOCALAPPDATA%\CIEL\data` on Windows. `CIEL_DATA_DIR` and `CIEL_PORT` override these. The default port is 4317. Stop the current service only after its tasks finish before installing a CIEL application update. Native engine updates have their own idle-only updater.

CIEL application updates are manual in this prototype. Build a package with a newer version or RPM release number, finish active tasks, stop the user service, install the new package, and start the service. The separate data directory preserves sessions and engine profiles. The RPM installs under `/opt/ciel`; the rootless tarball installer uses `~/.local/share/ciel/app`. Do not run both installations against the same data directory at once.

## Engines and accounts

Use **Settings → Agents & accounts** to install official runtimes into CIEL's private directory and connect fresh profiles. CIEL does not import existing Codex desktop or CLI sessions.

- **Codex:** ChatGPT subscription sign-in, using a device code. Available models come from the native App Server.
- **Claude Code:** Claude subscription sign-in. The current native CLI flow must be completed on the execution computer. Model selection uses native defaults or a model ID, because the CLI provides no supported catalog endpoint.
- **OpenCode:** enter your OpenRouter API key in the app. This engine uses OpenRouter billing. CIEL never switches a subscription engine to API billing.

Full access runs as your OS user, not administrator/root. Engine permission controls are shown according to native capabilities. Handing a task to another engine preserves the visible conversation and supplies a summary plus access to saved task history; internal model state is not transferable.

## Remote computers

Install CIEL on each computer. In **Settings → Computers**, enable its private Tailscale HTTPS endpoint and generate a short-lived pairing code. On the viewing computer, pair the destination URL with that code. All host APIs stay on loopback behind Tailscale Serve. Pairing requires an authenticated local CIEL session. Existing Tailscale routes are preserved.

Pair in both directions if either computer should be able to view the other. Two browser tabs can select different computers and keep those selections when reloaded. See [operation and capability map](docs/OPERATIONS_AND_CAPABILITIES.md) for storage, data transfer, and current integration limits.

The selected host owns execution and credentials. No project files are synchronized. An offline destination gets an offline screen; another host's sessions never fill in for it. Tasks continue with the browser closed or screen locked, provided their host remains awake.

## Sessions and skills

The sidebar groups sessions under expandable projects. Several projects can stay open at once; choosing a conversation never filters out other projects. A project's **+** creates a session there immediately, using the current agent choices. The first message supplies its title. Running sessions show a spinner, an unread completed session shows a green check until its result is opened, and sessions needing input or recovery show orange.

Open a skill in **Skills Library** to read its full contents. Editing is a separate action. Computer pairing, agent accounts and installations, and project folder/preview setup live in Settings; switching the active computer stays in the top bar.

Activity shows one entry per tool call, scoped to its turn. Completed activity is collapsed in the conversation; expand a tool to inspect its input, result, duration, engine and native name. Readable labels are shared across engines (for example, Codex `commandExecution`, Claude `Bash` and OpenCode `bash` appear as **Run command**). Internal session/read/snapshot events stay out of this view, including in older saved conversations. The turn picker changes both file changes and the activity inspector.

## Reliability and limits

Runs and events persist in SQLite. Independent folders can run concurrently; the same folder and overlapping parent/child folders are serialized. Duplicate submissions are idempotent. After a service crash, unfinished runs are marked interrupted and never silently replayed. The service rejects another owner of the same data directory.

Unread completion and attention indicators persist. Optional browser notifications apply only to the selected host; reconnecting does not replay old notifications. Closed-PWA notifications are not guaranteed.

Turn changes compare workspace snapshots before and after a run without modifying the Git index. Generated/ignored files are excluded and large/binary files are summarized. Concurrent external edits cannot be attributed to a specific agent; the panel shows changes observed during the turn.

Credentials remain in native host profiles and protected host data files. Pairing is intended for your trusted Tailscale devices. Back up the data directory privately: native profiles and connection files may contain credentials. The shared library's export is separate from this backup.

Browser/desktop automation, cross-host task migration, automatic shared-library synchronization, importing old application history, and an embedded editor are outside this version. See [implementation plan](IMPLEMENTATION_PLAN.md) and [verification notes](docs/VERIFICATION.md) for acceptance status.
