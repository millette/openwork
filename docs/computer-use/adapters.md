# Computer use adapters

Computer use drives one approved app window on a *computer*. A computer is an
adapter: this Mac (the native helper) or a remote machine such as a Freestyle
or Daytona Linux VM. Each chat picks one in the Computer popover and keeps it.

## Layers

| Layer | File | Knows about |
|---|---|---|
| Agent tools (`computer_*`) | `apps/server/src/opencode-plugins/openwork-computer-use.ts` | Nothing about computers; forwards to the desktop |
| Broker | `apps/desktop/electron/computer-control.mjs` | Consent per chat, Always allow, one session at a time, handoff, receipts, post-action observations, the in-chat request |
| Adapter contract | `ComputerAdapter` in the broker | `id`, `label`, `placement` (`local`/`remote`), `readiness()`, optional `setup()`, `connect()` returning a transport for the seven native tools plus `openwork/ui` notifications |
| This Mac | `computer-local.mjs` + `packages/computer-use` | macOS permissions, the Swift helper |
| Remote runtime | `computer-remote.mjs` | Turns a small driver into the full contract: sessions, window approval, observation ids, at-most-once receipts, batched actions, zoom, take over/continue, watch frames |
| Linux driver | `computer-x11-driver.mjs` | xdotool and ImageMagick over two VM primitives: run a command, read a file |
| Provider bindings | `computer-targets.mjs` | How to reach a VM through `@openwork/sandbox` (`blocks.run`, `blocks.files`) |

The broker never changes for a new computer. A new kind of machine needs a
driver (`windows`, `screen`, `focus`, `screenshot`, `input`); a new provider for
a Linux VM needs only a machine binding (`run`, `read`).

## Point computer use at a VM

Start the desktop with these in its environment:

```sh
OPENWORK_COMPUTER_FREESTYLE_VM=<vm id> FREESTYLE_API_KEY=<key>
OPENWORK_COMPUTER_DAYTONA_SANDBOX=<sandbox id> DAYTONA_API_KEY=<key> DAYTONA_API_URL=<url>
OPENWORK_COMPUTER_DISPLAY=:99   # the VM's X display, default :99
```

The VM must be running with an X display, `xdotool` and ImageMagick
(`apt-get install -y xdotool imagemagick`). Freestyle worlds already run Xvfb
on `:99`. Readiness reports what is missing. The Computer popover then lists the
VM next to this Mac; allow the chat as usual and ask for the task.

## Differences from this Mac

- No accessibility tree: observations return the image only, and the agent acts
  with coordinates (`press`/`set_value` are refused; `assist` mode is not offered).
- Keyboard: `command` is sent as control and `option` as alt, so Mac-style
  shortcuts work; discovery says so.
- No macOS permissions or presence overlay; the floating Computer view shows the
  VM's window, and Take over pauses the agent there.
- One session at a time across all computers, as on this Mac.

## Not yet

- Credentials come from the desktop's environment, for development and
  self-hosted use. A product path should broker VM access through Den with the
  member's policy instead of a key on the desktop.
- No provisioning: the adapter drives an existing VM and never creates, wakes or
  pays for one.
- Person input on the VM (a VNC view in the Computer view) and Windows VMs.
