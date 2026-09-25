# CIEL operation and capability map

Checked 2026-09-24 against the first prototype and current vendor documentation.

## Start and install

- Fedora installation: launch **CIEL** from the application menu or open `http://127.0.0.1:4317`. The enabled `ciel.service` systemd user service starts at sign-in and survives closing the browser. `systemctl --user status ciel.service` checks it.
- Windows installation: launch **CIEL** from Start or open `http://127.0.0.1:4317`. The per-user sign-in launcher starts the hidden host process.
- Source checkout: Node.js 24 and pnpm 11; `pnpm install`, then `pnpm dev:app` to install and start the persistent user service and separate Fedora development window. Open **CIEL Dev** from the application menu later or browse to http://127.0.0.1:5173. Development uses its own data directory and ports. Use `pnpm build && pnpm start` for the bundled host.
- Distribution: `pnpm build && pnpm package all`; use the versioned RPM or Linux tarball on Fedora, and compile the Windows payload zip into an installer on Windows. The installers bundle Node.js. Stop the host only after its active tasks finish before replacing its backend. The Fedora launcher opens a native GTK/WebKitGTK window when those packages are present.
- The Fedora Laptop was originally installed using the rootless tarball, so `rpm -q ciel` reports no installed RPM. Its current `CIEL Desktop` launcher now opens the native GTK window. Installing an RPM alongside that tarball would create a second application tree and leave the user-level systemd unit in priority; migrate once before using RPM upgrades.
- The RPM installs the application under `/opt/ciel` and keeps session/engine data under `~/.local/share/ciel`. Subsequent RPM builds need a higher version or release; after active tasks finish, `dnf upgrade` replaces application files and the user service can be restarted. There is no CIEL RPM repository yet.
- Each host checks the latest published GitHub Release for a newer version with a complete, checksummed platform asset. A discreet logo badge appears only for that release. Rootless Fedora installations download and verify the Linux archive, then update the user service after sessions are idle; startup health is checked and failure rolls back. Windows and RPM installations link to the release for installer-based updating. The existing **Agent runtime updates** switch controls Codex, Claude and OpenCode, not CIEL app updates.
- On each execution computer, open **Settings → Agents & accounts** to install the native engines and sign in. CIEL uses separate native profiles on each host; signing into a vendor desktop app does not automatically sign CIEL in. Codex and Claude use their subscriptions; OpenCode uses an OpenRouter key if selected.

## Multiple computers and windows

Install CIEL and Tailscale on both computers. On each, use **Settings → Computers** to enable the private HTTPS endpoint and create a five-minute pairing code. On the other computer, add its `https://...ts.net:8443` address with the code. Pair in both directions when each should list the other. Pairing and host routing use authenticated requests; the regular CIEL HTTP interface stays on loopback.

The Fedora Laptop and Main PC installations were paired in both directions on 2026-09-24. Fedora reached the Main PC through its own CIEL API. This pairing remains in each host's `connections.json` unless revoked or its installation is reset. Browser tabs can select different computers at once; the selected host is remembered separately per tab across reloads.

The selected host owns the project folder, credentials, native engine processes, sessions and run queue. Selecting a host replaces the whole visible workspace. A viewing browser sends requests to its local CIEL host, which proxies only the selected paired host's API through Tailscale. It does not copy repositories, native profiles, or the session database. An offline host shows as unavailable while its saved data stays on that host.

On initial selection, `/state` sends the host's project and session summaries, settings, library entries and status cursor. The UI then requests `/tasks/:id` for the selected conversation, including that conversation's messages, runs, events and changes; SSE delivers updates. This is on-demand per conversation, though the current library content is included in `/state` and a long selected conversation is still fetched in full. These are the first payloads to paginate or split for larger histories. A spot check on 2026-09-24 measured about 36 KB for the empty Main PC state and about 0.6 seconds through the current tailnet path; that is an observation, not a latency guarantee.

Host data lives in `$XDG_DATA_HOME/ciel` (normally `~/.local/share/ciel`) on Linux or `%LOCALAPPDATA%\CIEL\data` on Windows. CIEL stores its own projects, tasks, messages, events, read cursors, approvals and native-session references in `ciel.sqlite` with WAL. Engine-managed conversation/profile data and credentials remain in the host-local `engines/` directory. Pairing secrets are in host-local `connections.json`; shared library content is in `library.json`. Back up the data directory privately. Files in registered project folders stay where they already are and are not part of this data directory.

## Full-capability requirement

CIEL runs the official Codex App Server and Claude Code CLI rather than replacing their models. It currently exposes text turns, native subscription login, model/effort selection where discoverable, resume, tool activity, interruption, approvals, and three permission modes. There is no imposed model token cap in CIEL. The current UI and adapters still expose only a subset of each vendor application's tools and workflows. Account plans, vendor policy, OS support and native client protocols can impose their own limits.

| Capability | Prototype today | Work needed for CIEL parity |
| --- | --- | --- |
| Native engines and coding tools | Present; separate CIEL profiles | Verify authenticated end-to-end turns, approvals and handoffs on both hosts; preserve native config and update compatibility |
| Skills and plugins | CIEL library projects simple `SKILL.md` skills; native extensions can be listed | Native plugin installation/management and dependency handling; avoid flattening plugins into instructions |
| Google, Slack and other connectors | Library projects local stdio MCP commands only, with host environment references | Add remote HTTP MCP, OAuth lifecycle, per-host connection status and native connector/plugin mapping |
| Browser control | CIEL preview links exist; no agent browser-control tool is installed | Start with Playwright MCP and its browser extension on the execution host for existing logged-in tabs; offer a separate managed browser profile for testing |
| Computer control | None in CIEL | Add host-local, OS-specific screen/accessibility tool bridges with explicit per-app grants; Windows needs an active desktop, Fedora Wayland needs portal/accessibility feasibility testing |
| Scheduled tasks | None in CIEL | Persist schedules and run records on the host; run through the existing queue with timezone, missed-run policy, concurrency and notification controls |
| App-only features | No CIEL equivalent for every desktop feature | Inventory and verify individually; desktop browser/computer use and account-synced connectors cannot be assumed to appear in a separate native profile |

A skill supplies instructions and workflow. Connectors, browser actions, computer control and scheduling also require an actual host service or MCP tool; adding text to the Skills Library cannot grant these capabilities by itself. Preserve the official engines' native tool access, use supported APIs, and report an unavailable capability explicitly rather than silently falling back to a reduced behavior.

Claude Code's CLI can use its **Claude in Chrome** extension with `--chrome` in interactive sessions. Its availability through CIEL's current noninteractive `-p` adapter has not been verified. Codex CLI does not include the desktop app's built-in browser; a browser MCP integration is the portable route. Claude and Codex desktop computer-use systems are product/OS features, not capabilities automatically inherited by a CIEL-launched process.

## Performance work order

1. Keep host selection and session summaries small: omit full library bodies from `/state` and fetch selected library items separately.
2. Page conversation history and activity; load the visible tail first and older turns on scroll. Avoid re-fetching the full selected detail for every stream event.
3. Keep SSE cursors durable and scope caches by host and task. Never blend data from two hosts while switching.
4. Run browser and desktop tools on the execution host. Send actions, structured results and requested screenshots over the authenticated channel, not whole profiles or repeated full-screen streams.
5. Benchmark local, direct tailnet and relayed tailnet paths with growing session histories before setting a responsiveness target.

## Sources

- [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Codex browser](https://learn.chatgpt.com/docs/browser), [Codex Computer Use](https://learn.chatgpt.com/docs/computer-use), [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Claude Code Desktop](https://code.claude.com/docs/en/desktop), [Claude Code in Chrome](https://code.claude.com/docs/en/chrome), [Claude scheduling](https://code.claude.com/docs/en/scheduled-tasks)
- [Playwright MCP browser extension](https://playwright.dev/mcp/configuration/browser-extension), [Playwright CDP](https://playwright.dev/docs/api/class-browsertype)
