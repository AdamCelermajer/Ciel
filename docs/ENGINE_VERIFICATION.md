# Native engine verification

Verified 2026-09-23 on Fedora Linux and native Windows 11. These checks used isolated CIEL profiles and made no paid model requests. Existing Codex, Claude, and OpenCode user profiles were not read or copied.

| Engine | Native version on Windows | Verified protocol | Sign-in state during probe |
| --- | --- | --- | --- |
| Codex | 0.156.1 | App Server stdio initialize, account read, model list; 7 models | Signed out of isolated profile |
| Claude Code | 2.1.280 | CLI version and JSON `auth status` | Signed out of isolated profile |
| OpenCode | 1.18.32 | HTTP health and OpenRouter provider catalog; 374–383 live models | No OpenRouter key in isolated profile |

`RuntimeManager` installed each official npm runtime into `C:/Users/adamc/AppData/Local/CIEL/data/runtimes` on Windows, validated it with a disposable profile, and activated the managed runtime. Each adapter returned `installed: true` and `protocolHealthy: true` before and after `dispose()`/restart. The local Fedora Codex App Server test independently initialized an unsigned profile, discovered models and reasoning effort options, and restarted successfully. Protocol unit tests cover Codex device-code response, native approval response, streamed turn normalization, and refusal of API-key auth. Shared library tests cover credential rejection, native skill projection, MCP environment references, and refusal to overwrite a modified native skill.

The process guardian was tested with a native child and grandchild. Both exited after normal adapter stop and after abrupt parent exit on Windows. A POSIX child-plus-grandchild test verified process-group cleanup after the parent pipe closed. Native Windows status and lifecycle checks ran on `adampalace-pc` with Node 26.3.0; they were not inferred from Linux mocks.

The following still requires user account setup or a paid turn to verify end to end:

- Codex ChatGPT device-code sign-in was initiated only in a fake protocol test. No real code was redeemed. The adapter refuses API-key auth.
- Claude Code subscription sign-in was not completed. Its CLI currently exposes a browser callback flow on the execution host, with no documented device-code/manual-code option; remote sign-in needs a browser on that host or another supported host-side ceremony. The adapter refuses Console/API auth and cannot enumerate Claude models through the CLI.
- No OpenRouter key was entered. OpenCode key storage and actual model turns were not exercised.
- Native Claude/OpenCode approval prompts, resume across engines, projected MCP tool use, and full/read-only filesystem behavior require authenticated live turns. Deterministic tests and protocol schemas cover their adapter wiring, but do not establish an end-to-end account-backed result.

CIEL passes full-access, ask, and read-only modes to each native engine and fails when a selected mode or account is unavailable. MCP environment fields require host environment-variable references. Native credential stores are excluded from library exports; common pasted credential patterns are rejected. Arbitrary text still needs care when sharing an export. Native extensions remain in per-engine CIEL profiles.
