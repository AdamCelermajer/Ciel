# Verification status

CIEL 0.1.0 is an implemented first version. It is not yet marked ready for unrestricted daily use: authenticated model turns and account-backed handoffs remain acceptance gates.

## Verified without account credentials

- Native Fedora and Windows engine installation and protocol checks for Codex 0.156.1, Claude Code 2.1.280, and OpenCode 1.18.32. Fresh CIEL profiles remain separate from existing coding apps.
- Process guardian cleanup for native child and grandchild processes, including abrupt parent exit.
- Deterministic host tests exercise overlapping-folder queues, independent runs, duplicate submission, cancellation, durable unread cursors, crash recovery without replay, single-owner SQLite access, engine handoffs, and private HTTP/WebSocket preview forwarding.
- Shared library tests cover credential-pattern rejection, MCP environment references, native skill projection, and preservation of externally modified skills.
- Workspace tests cover dirty starting files, additions/deletions, excluded generated files, and incomplete snapshots.
- A checksum-verified Node.js 24.21.0 runtime is included in Linux and Windows artifacts. The Windows GUI installer source compiles on the actual PC.

## Browser and installed-app acceptance

Browser integration uses two real local host services with authenticated pairing and an explicitly deterministic test engine. This validates UI scheduling and isolation; it does not establish provider-backed coding performance. The browser scenarios cover immediate host-context replacement; separate host selections across two tabs and reloads; background completion across host switches and reload; mobile navigation; concurrent independent sessions with preserved unread results and several expanded projects; unread green checks clearing after a result is opened; orange approval attention followed by green completion; readable skills with setup under Settings; and deduplicated tool activity with readable/native names, collapsed completed turns, historical-noise filtering, and matching turn selection in the inspector. Session creation is one click without a configuration dialog. Desktop and mobile screenshots were inspected, including dark scrollbar styling. TypeScript checks and the production build pass. The automated suite has 28 passing tests; the optional native Codex test was run separately by the adapter worker.

The activity normalizer was also checked read-only against the user's saved Codex Wikipedia turn: its 74 stored events produce one completed Web search row. No additional model prompt was submitted. Adapter regression fixtures cover native Codex tool classification, message boundaries, and failure metadata, Claude tool IDs, and OpenCode text deltas and repeated tool states.

## Installed on the user’s computers

- Fedora Laptop: the per-user systemd service is enabled and running, serving http://127.0.0.1:4317. The actual CIEL project folder is registered. No persistent terminal is needed.
- Main PC: the Windows GUI installer ran successfully, with a hidden per-user launcher and a sign-in startup entry. Its local health endpoint responds using the bundled Node runtime. A transient extraction lock found during native installation is handled with retries and activation rollback.
- On 2026-09-24, Tailscale Serve became available. Fedora Laptop and Main PC were paired in both directions through private HTTPS endpoints. A Fedora CIEL request for the Main PC state returned successfully; the measured response was 35,881 bytes in 619 ms on that path. This checks reachability and host selection, not authenticated model execution.
- Startup configuration was checked without logging the user out or rebooting either computer. Authentication-backed work remains pending sign-in.
- The simplified interface and activity updates can be applied without restarting either host service. The matching backend bundle is staged for the next normal service start; its automatic first-message session naming and adapter improvements become active then. Native sign-ins and runs are preserved.

## Account setup still needed

Connect Codex to ChatGPT through the device-code flow in **Settings → Agents & accounts**. Complete Claude subscription sign-in on each execution computer. Enter an OpenRouter key directly in CIEL if using OpenCode. No key should be pasted into a task message.

Then verify a small real coding turn, streaming/tool activity, interruption and native approvals for each engine, followed by Codex → Claude → OpenCode → Codex in one task. No paid OpenRouter prompts have been sent during implementation.

## Deliberate limits

- Native engine updates are automatic only while idle, with disposable protocol validation and a native-profile backup before activation. CIEL application updates are manual; there is no published update feed for this personal project yet.
- Shared MCP connections currently support local stdio commands and environment-variable references. Unsupported configuration is rejected explicitly. Native plugin installation remains engine-specific.
- A preview started by an earlier host process may continue after a service restart. CIEL will not kill a stored PID without proof it still owns the process; the interface reports uncertain ownership.
- Browser notifications require browser permission and a running interface. Durable unread indicators work without notifications.
- Change snapshots report changes observed during the turn, including any simultaneous edits from outside CIEL. They are not an attribution proof or complete filesystem audit.
- Native account sign-in and permission integration are documented in [ENGINE_VERIFICATION.md](ENGINE_VERIFICATION.md).
