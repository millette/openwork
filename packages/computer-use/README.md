# Computer Use

A small macOS 14+ helper that lets OpenWork see and use one app window the
person approves, for one short session. It is a single Swift executable
(`native/`) that the OpenWork desktop packages as **OpenWork Computer Use.app**
(bundle id `com.differentai.openwork.computer-use`) and launches from its main
process. It has no model, API key, network listener or clipboard access.

## Commands

| Command | Purpose |
| --- | --- |
| `ComputerUse mcp-embedded` | What OpenWork launches. MCP over stdio; the desktop hosts approval, Take over, Continue and Stop over the private `openwork/ui` channel. |
| `ComputerUse mcp` | Standalone MCP server for local testing, with native consent and a small native control panel. |
| `ComputerUse --check` | Prints `{ok, accessibility, screenRecording, supported, protocolVersion: "openwork.computer-use/1"}` and exits. |
| `ComputerUse permissions accessibility\|screenRecording` | Triggers the macOS prompt and opens the matching System Settings pane. |
| `ComputerUse permissions-guide accessibility\|screenRecording` | Floating permission guide driven by its parent over line-delimited JSON (below). |

## Sessions and tools

A session covers one app, one window and one mode, for at most 15 minutes,
pauses after two idle minutes and allows at most 200 actions. The modes are
`observe` (read only), `assist` (accessibility press/set value) and `control`
(also targeted mouse and keyboard input; the approved window must be in front).
A kernel-held lock allows one session at a time. Grants, element references,
screenshots and receipts live in process memory and are discarded on close.

| Tool | Purpose |
| --- | --- |
| `computer_discover` | App identities, permissions, modes, keys, shortcuts and limits; reads no window content |
| `computer_open_session` | Launch the app if needed, then ask the person to approve a window and mode |
| `computer_observe` | Compact interactive (or all) elements plus an optional window PNG |
| `computer_zoom` | A region of the current observation at full resolution; read only |
| `computer_act` | One action or an ordered batch (1–8) against a fresh observation, with a display-only `intent` |
| `computer_session_status` | Mode, pause state, action count and expiry |
| `computer_close_session` | Revoke the grant and release control |

Every call is validated at the native boundary. An observation authorizes one
`computer_act` within 60 seconds; before input the helper re-checks the app,
window, geometry, structural content and element identity, and coordinates
also need an unchanged screenshot and a live hit test. `request_id` makes a
retry return the original receipt instead of repeating input. A `dispatched`
receipt is not proof the task succeeded: observe again to verify. Terminal,
permission, credential and host apps (`com.differentai.openwork*`,
`com.differentai.opencoworker*`) can never be targeted. Failures are MCP
`isError: true` results with machine-readable `code` and `next` fields.

Person input in the approved app, an app switch, sleep or idle expiry pauses
the session and releases held input. Only the person's Continue resumes it;
neither time nor the agent can.

## Embedded protocol (`openwork/ui`)

In `mcp-embedded` mode the helper and host also exchange JSON-RPC
notifications with method `openwork/ui`:

- Helper → host: `{kind: "state", id, phase, appName, appID, pid, windowTitle,
  task, mode, status, canContinue, windows?}` where `phase` is `approval`,
  `working`, `paused` or `closed` (`windows` only during approval);
  `{kind: "frame", id, sequence, capturedAt, width, height, mimeType, data}`
  watch frames (PNG, at most 5 per second, only while the host is watching and
  the agent is working); `{kind: "input", id, sequence, action, phase, at, x?, y?}`
  for each dispatched input.
- Host → helper: `{id, action}` with `action` one of `approve` (plus
  `windowId`), `deny`, `takeover`, `resume`, `stop`, or `watch` (plus
  `visible`). Messages for another `id` are ignored. `resume` only works while
  the session is paused and Continue is allowed.

## Presence

While a session runs the helper draws presence on the desktop: a frame around
the approved window, a named cursor that glides to each input with click
ripples, drag trails, a typing indicator and highlighted controls, narration
from `intent`, and a "thinking" state between inputs. A pill over the window's
buttons offers Take over, Continue and Stop, shows "Your turn" while the person
has control, and moves to the top of the screen when the window is hidden.
When the session ends the cursor says it is "all yours" and fades out. Every
overlay is excluded from screen capture, the frame and cursor ignore the mouse,
and the pill never activates the helper.

The host may pass `OPENWORK_COMPUTER_USE_PRESENCE` as JSON
`{"name": "…", "color": "#rrggbb"}`. The name falls back to "OpenWork" and the
color to blue. Presence is display only and never grants access. Embedded mode
always shows it; standalone `mcp` shows it only when the variable is set.

## Permission guide protocol

`permissions-guide <permission>` shows a floating guide beside System Settings
and requests the permission. Its stdout and stdin carry one JSON object per line.

- Guide → host: `{"event": "ready"}` first, then `requested` (with
  `permission`), `refresh` (please send fresh status), `visibility` (with
  `visible`) and `return` (the person chose Back to OpenWork).
- Host → guide: `{"type": "status", "readiness": "ready" | "setup-required" |
  "unavailable" | "unsupported", "permissions": {"accessibility": bool,
  "screenRecording": bool}}`, `{"type": "request", "permission": …}` and
  `{"type": "close"}`.

The guide exits on `close`, on stdin EOF, on SIGTERM, after five minutes, or
after `return`. Opening System Settings is never treated as a grant: readiness
always comes from a fresh `--check`.

## Build and verify

```
pnpm --filter @openwork/computer-use build:native
swift test --package-path packages/computer-use/native
node apps/desktop/scripts/prepare-computer-use-helper.mjs --force --outdir apps/desktop/resources/helpers
```

`prepare-computer-use-helper.mjs` builds the release binary and assembles and
signs the helper app; desktop dev and packaged builds run it automatically.
Pointer input relies on an availability-checked lookup of the private
`CGEventSetWindowLocation` symbol; without it, pointer actions fail explicitly
while accessible controls keep working.
