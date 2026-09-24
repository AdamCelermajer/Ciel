# CIEL implementation and delegation plan

Status: first implementation, automated/browser checks, and native installations are complete. Real tailnet pairing needs Tailscale Serve enabled; account-backed coding turns need native sign-in. See docs/VERIFICATION.md for evidence and limits.

## Agreed product

CIEL is a personal coding-session manager: a React PWA and a persistent host service on each work computer. Selecting a host selects that computer's files, agent processes, credentials, conversations, skills, and plugins. The viewing computer is an interface; remote projects are not copied to it. Each host remains independently usable.

Switching computers replaces the entire visible CIEL workspace with the destination host's state. This includes sessions, projects, agents/accounts/models, skills, settings, queues, search results, drafts, change panels, and notification indicators. Do not merge hosts or leave the previous host's content visible while the next host loads or is offline. Only the saved host chooser and device-level presentation preferences are global. Host switching does not stop work on the previous computer or migrate any data.

- Initial platforms: native Windows and Fedora Linux. Start invisibly after OS sign-in; continue when the browser closes or the screen locks. Work cannot continue while its execution host is asleep or powered off.
- Agents: Codex with ChatGPT subscription login, Claude Code with Claude subscription login, and OpenCode with an OpenRouter API key. No automatic switch to metered API billing.
- Fresh CIEL-managed native profiles and conversations. No migration of existing desktop-app history or modification of its stores.
- One CIEL task can continue across engines, with visible handoffs and native session IDs retained underneath it.
- Sessions run asynchronously on the host service. Starting work immediately leaves the interface free to create/open another session, navigate elsewhere, or switch computers. Execution never depends on which conversation is displayed. Multiple independent sessions can execute concurrently; the existing same-folder scheduling rule still applies.
- Persist completion/unread state per session. Show a running indicator, a green completion check with a text label, an attention state for required input, and a failure state. A finished turn marks its session ready for attention without archiving the task. Offer optional system notifications for the selected host when browser support and permission are available.
- Full supported access within the OS user's privileges by default; permissions configurable per session.
- Existing project folders. Queue runs sharing the same canonical folder; different folders can run concurrently. No automatic branches or worktrees in v1.
- Native extensions remain native. Instructions, memories, skills, and MCP connections enter the host-local shared library only when explicitly saved. Selected export/import is supported; credentials are excluded.
- Browser/desktop automation, automatic host-to-host library sync, a manual code editor, and old-history imports are deferred.

Visual reference: `docs/design-reference.png` guides appearance, not interaction. Use a dark workspace with a persistent host switcher, conversation and changes panel. Put sessions directly under expandable projects in one sidebar; multiple projects can remain expanded without filtering one another. Show running spinners, green completions (including unread), and orange input/failure/interruption indicators instead of status filter tabs. A project's + immediately creates a session using current/default agent choices, with no setup dialog; the first prompt supplies the title. Primary navigation contains Sessions, Skills Library and Settings. Agent accounts/runtime setup, computer pairing and project folder/preview management belong within Settings. Library entries open a readable full-content view with editing separate.

Collapse side panels on smaller screens. All workspace content belongs to the selected host. A task link targeting another host first performs a full host-context switch. Changing hosts does not migrate tasks. Agent handoff is automatic after execution has stopped, and changes follow the selected turn. Use real host/model/status data; sample labels in the reference are illustrative.

## Team and cost controls

The parent task remains the architecture and integration lead using its current model. Implementation workers use explicit `model: gpt-6-sol`, `reasoning_effort: high`, and `fork_turns: none` with a self-contained brief. The current session has four total concurrency slots: the parent plus at most three workers.

This implementation-team limit is not a three-session limit in the CIEL product. Product runs are independent host-owned jobs, subject to folder ownership and actual engine/provider capacity.

Workers receive only the relevant requirements, frozen interfaces, owned paths, dependencies, acceptance criteria, and reference files. They do not receive the full conversation by default. Reuse a worker for closely related follow-up work; start a new focused context when ownership changes substantially.

- Delegate bounded implementation and focused review. Do not use parallel workers for dependent steps or repeat the same research across workers.
- Each editable path has one owner. Workers request shared-contract and dependency changes from the parent; they do not independently rewrite root manifests, lockfiles, or shared types.
- Workers add meaningful tests for their behavior and report changed files, checks run, and unresolved limitations. Do not write tests that merely restate styling or implementation details.
- The parent reviews shared interfaces, authentication boundaries, session ownership, persistence, handoffs, and final integration. Routine fixes return to the owning worker.
- Use one or two workers when that is the available independent work; three is a ceiling, not a target.
- Workers do not spawn additional agents. Avoid speculative features and repeated broad test runs after the relevant checks pass.
- These settings aim to reduce expensive parent-model work. Parallelism can still increase total usage; do not promise a savings percentage or silently upgrade worker models.

## Foundation and ownership

Use a pnpm TypeScript workspace: React/Vite for the PWA, Fastify for the host API, SQLite with WAL for host-local persistence, Vitest for unit/integration tests, and Playwright for UI acceptance tests. Bundle a supported Node.js LTS runtime for distribution. Use HTTP commands and resumable SSE for UI events; keep provider processes behind host-side adapters.

| Area | Ownership during a wave |
| --- | --- |
| Root workspace configuration, lockfile, shared contracts, architecture decisions | Parent |
| `apps/host` — persistence, API, scheduler, recovery | Host worker |
| `apps/web` — responsive interface and client state | UI worker |
| `packages/adapters/<engine>` — native engine protocols | Assigned adapter worker |
| `packages/workspace`, `packages/library`, `packages/transport`, `packages/platform` | Assigned later as separate bounded work |

Before parallel implementation, the parent scaffolds the workspace and freezes a minimal contract package for Host, Project, Task, Run, Event, Approval, ChangeSet, and EngineCapabilities. Include host ownership, native session references, command idempotency IDs, event sequence cursors, durable session attention/read cursors, and distinguish offline hosts from failed/interrupted runs. Submission acknowledges a host-owned job without waiting for the turn to finish. Keep native event payloads available for diagnostics while presenting normalized activity to the UI.

Scope all host data, client cache keys, persisted drafts, routes, and event subscriptions by host identity. On a host switch, clear the rendered workspace, detach old subscriptions, cancel old reads, and mount the destination workspace under a new selection generation. Discard late responses/events from earlier generations. Already-submitted commands retain their original destination; never reroute or resubmit them to the newly selected host. A loading/offline destination gets its own empty status screen, not the previous host's workspace.

Completion and attention events are durable and survive disconnects. Keep a completion badge until the corresponding new result is actually displayed to the user; merely visiting the session before completion does not mark a future result read. Deduplicate optional system notifications by host/run/event on the viewing device. Notify only for the currently selected host; previous-host completions remain stored there and appear when switching back. Reconnection restores unread indicators without replaying a burst of old system notifications. If notification permission is denied or the PWA is closed and cannot receive events, work still proceeds and durable badges appear on the next connection. Closed-app system notifications are not a v1 guarantee.

Adapter operations cover authentication/status, model discovery, start/resume session, start/interrupt turn, approval responses, and supported extension operations. Capabilities explicitly describe unavailable controls. A fake adapter is permitted for deterministic tests and development fixtures only; production never represents it as a live engine.

## Implementation waves and gates

### 0. Foundation and integration feasibility

The parent owns contracts and workspace setup. One Sol worker validates Codex App Server authentication, discovery, streaming, resume, interruption, and approvals. A second independently validates Claude Code's supported CLI subscription path and OpenCode/OpenRouter's server API. These are focused probes in disposable CIEL profiles, with exact versions and observed limitations recorded.

Use Codex App Server over stdio. Use Claude Code's supported programmatic CLI interface with structured streaming and its supported permission bridge. Use OpenCode's HTTP client/server interface. Keep provider credentials on the execution host and let native engines manage their subscription login lifecycle.

Gate: confirm the selected integrations can satisfy the required login and session behaviors before building UI that assumes them. If a subscription path fails, preserve the requirement, report the specific blocker, and do not replace it with paid API access. Fedora checks can run locally; native Windows checks require the PC and must not be claimed from mocks or Linux-only tests.

### 1. First working local task

Run three independent workers against the agreed contracts:

1. Host worker: project/task storage, durable events and attention state, asynchronous job submission, one active turn per task, concurrent independent tasks, folder scheduling, HTTP/SSE endpoints, and process lifecycle.
2. UI worker: the reference dashboard, host/project/task navigation, chat streaming, model selection, permission controls, session completion indicators, optional system notifications, and honest loading/offline/error states.
3. Codex worker: production adapter and native protocol tests based on the feasibility result.

The parent integrates the service and UI, reviews ownership and persistence, and exercises a real task. Gate: start a Codex task, see tool activity, create/open and run another task in an independent folder while the first runs, and receive the first task's completion indication without changing the active conversation. Close/reopen the browser, retain unread completion badges, continue the same conversation, interrupt a run, and verify duplicate submissions do not start duplicate work. Verify an approval request or failed run in one session does not block navigation or unrelated runs. Exercise both notification permission granted and denied.

### 2. Remote operation and turn changes

Assign transport/pairing, workspace change capture, and UI integration to separate workers. The parent owns host-routing integration and the authentication review.

Pair installations explicitly. Route remote operations through the selected host over private Tailscale HTTPS endpoints backed by loopback listeners. Use authenticated connections, strict origin checks, and protected local secrets. Preserve existing Tailscale routes. An offline host keeps its task ownership; drafts are not silently executed on another host.

Capture before/after snapshots of included workspace files without changing the Git index. Include shell-created changes, additions/deletions, and binary summaries; exclude generated/ignored files by default and separate pre-existing edits. Label uncertain attribution as changes observed during a turn. Maintain run ownership until the actual worker has stopped; timeouts alone must not free a folder for another writer.

Gate: operate a Windows PC task from Fedora, disconnect and reconnect, replay missed events once, test same-folder queues and parallel different-folder runs, and inspect changes for current and earlier turns. Switch rapidly between hosts with different data and with overlapping project/task IDs; inject late HTTP/SSE results, an offline destination, and in-flight commands. Confirm no previous-host projects, sessions, drafts, settings, change panels, or notifications leak into the new workspace and no commands change destination. Let a task finish on the previous host, verify it continues without surfacing in the new host's UI, then switch back and see its completed/unread state. Inject worker/service failures and confirm explicit recoverable interruption instead of stale ownership or automatic command replay.

### 3. Additional engines, handoff, and shared library

Separate workers own Claude, OpenCode, and the library. The parent owns the handoff coordinator and integrates the engine picker and capability-specific controls.

Stop or finish the active turn before switching engines. Preserve the workspace and visible task history. Deliver the active request, decisions, relevant history, and workspace changes to the destination engine; expose on-demand task-history retrieval through CIEL tools. When returning to an earlier native session, supply intervening work. Do not claim lossless transfer of internal engine state.

Keep native plugins in their engine profiles. Project explicitly shared items through supported mechanisms, report compatibility/dependency failures, and preserve native settings. Provide library export/import without credentials. Show the actual authentication/provider mode and refresh model catalogs independently of runtime updates.

Gate: complete Codex → Claude → OpenCode → Codex in one task, verify intervening edits/context, exercise native permission requests, and verify shared skill use without native configuration being overwritten.

### 4. Previews, packaging, and daily-use reliability

Separate workers own preview supervision, Windows/Fedora startup/installers, and update management. The parent owns end-to-end acceptance and release integration.

CIEL can start or register dev servers and produce reachable private Tailscale links. CIEL-started servers live independently of an agent turn. Support WebSocket forwarding, keep preview content isolated from the control UI, and strip CIEL credentials before forwarding to project servers.

Deliver a Windows installer with a hidden sign-in launcher and a Fedora RPM with a user service. Bundle CIEL's runtime and guide official agent installation, native login, and prerequisites. Preserve project-managed dependencies and Docker environments. Provide health diagnostics, version/status reporting, and state export.

Automatically stage stable updates and validate adapter compatibility using disposable profiles. Activate only when the affected engine is idle, backing up affected state before activation. Restore the previous version and snapshot if activation fails before accepting new work. Do not automatically downgrade native data after new turns have been written. Upgrade CIEL's own service during an idle window with migration/recovery checks.

Gate: fresh Windows/Fedora installation, invisible startup, screen-lock/browser-close continuity, working remote preview/live reload, failed-update recovery, and history preservation across restart. Mark the release ready only after real cross-host acceptance; document any external setup still requiring the user's login.

## Completion and evidence

Each wave ends with a runnable increment, the relevant passing checks, and a short status update. The entire release is complete only when all four functional waves and native platform acceptance pass. Preserve the screenshots or concise logs needed to substantiate UI and runtime behavior without recording credentials. No artificial deadlines or cost percentages are assumed.

Relevant documentation checked during design:

- [Codex subagent model and effort configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex custom-client integration](https://learn.chatgpt.com/docs/app-server)
- [Claude Code programmatic interface](https://code.claude.com/docs/en/headless)
- [Claude authentication](https://code.claude.com/docs/en/authentication)
- [Claude SDK authentication boundary](https://code.claude.com/docs/en/agent-sdk/overview)
- [OpenCode client](https://opencode.ai/v2/docs/build/client)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
