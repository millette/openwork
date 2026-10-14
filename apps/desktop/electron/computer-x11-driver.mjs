// A computer use driver for a Linux VM with an X11 display. It needs only two
// things from the VM, which every `@openwork/sandbox` provider supplies: run a
// shell command and read a file. Input goes through xdotool and screenshots
// through ImageMagick, batched so one action costs one round trip.
import { randomUUID } from "node:crypto";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const KEYS = {
  enter: "Return", return: "Return", escape: "Escape", esc: "Escape", tab: "Tab", backspace: "BackSpace", delete: "Delete", space: "space",
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "Page_Up", pagedown: "Page_Down",
};
// Shortcuts written for a Mac work on Linux: command sends control.
const MODIFIERS = { command: "ctrl", control: "ctrl", shift: "shift", option: "alt" };
const TOOLS = ["xdotool", "import"];

/**
 * @param {{
 *   machine: { run: (command: string, timeoutMs: number) => Promise<{ exitCode: number, stdout: string, stderr: string }>, read: (path: string, timeoutMs: number) => Promise<Uint8Array> },
 *   display?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {import("./computer-remote.mjs").ComputerDriver}
 */
export function createX11Driver({ machine, display = ":99", timeoutMs = 20_000 }) {
  if (!/^:\d{1,3}(\.\d)?$/.test(display)) throw new Error("Use an X display such as :99.");
  const directory = `/tmp/openwork-computer-${randomUUID().slice(0, 8)}`;
  const run = (script, ms = timeoutMs) => machine.run(`export DISPLAY=${display}; ${script}`, ms);
  const key = (name, modifiers = []) => {
    const base = KEYS[String(name).toLowerCase()] ?? (String(name).length === 1 ? String(name) : String(name));
    if (!/^[A-Za-z0-9_+\-.,;:'"/\\=[\]`]{1,24}$/.test(base)) throw new Error(`Unsupported key ${name}.`);
    return [...modifiers.map((modifier) => MODIFIERS[modifier] ?? "ctrl"), base].join("+");
  };
  const integer = (value) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || Math.abs(number) > 100_000) throw new Error("Coordinates must be finite pixels.");
    return number;
  };
  const withModifiers = (modifiers = [], command) => {
    const keys = modifiers.map((modifier) => MODIFIERS[modifier] ?? "ctrl");
    return keys.length ? `xdotool keydown ${keys.join(" ")} && ${command}; xdotool keyup ${keys.join(" ")}` : command;
  };
  /** One shell line per step; markers report how far a batch got. */
  function step(action) {
    switch (action.type) {
      case "move": return `xdotool mousemove ${integer(action.x)} ${integer(action.y)}`;
      case "click": case "double_click": case "triple_click": {
        const repeat = action.type === "click" ? 1 : action.type === "double_click" ? 2 : 3;
        return withModifiers(action.modifiers, `xdotool mousemove ${integer(action.x)} ${integer(action.y)} click --repeat ${repeat} --delay 80 1`);
      }
      case "drag": {
        const [first, ...rest] = action.path ?? [];
        if (!first || !rest.length) throw new Error("A drag needs at least two points.");
        return [`xdotool mousemove ${integer(first.x)} ${integer(first.y)} mousedown 1`, ...rest.map((point) => `xdotool mousemove ${integer(point.x)} ${integer(point.y)}`), "xdotool mouseup 1"].join(" && ");
      }
      case "scroll": {
        // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right; one notch is about 100 pixels.
        const vertical = Math.min(24, Math.round(Math.abs(Number(action.delta_y ?? 0)) / 100));
        const horizontal = Math.min(24, Math.round(Math.abs(Number(action.delta_x ?? 0)) / 100));
        const parts = [`xdotool mousemove ${integer(action.x)} ${integer(action.y)}`];
        if (vertical) parts.push(`xdotool click --repeat ${vertical} --delay 30 ${Number(action.delta_y) > 0 ? 4 : 5}`);
        if (horizontal) parts.push(`xdotool click --repeat ${horizontal} --delay 30 ${Number(action.delta_x) > 0 ? 6 : 7}`);
        return parts.join(" && ");
      }
      case "type": return `xdotool type --delay 12 -- ${quote(action.text ?? "")}`;
      case "key": return `xdotool key --clearmodifiers ${quote(key(action.key, action.modifiers))}`;
      case "wait": return `sleep ${Math.min(3, Math.max(0.05, Number(action.ms ?? 0) / 1000)).toFixed(2)}`;
      default: throw new Error(`Unsupported action ${action.type}.`);
    }
  }

  return {
    platform: "linux",
    async describe() {
      try {
        const result = await run(`missing=""; for tool in ${TOOLS.join(" ")}; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done; echo "missing:$missing"; xdotool getdisplaygeometry >/dev/null 2>&1 && echo display:ok`, 10_000);
        const missing = result.stdout.match(/missing:(.*)/)?.[1].trim();
        if (missing) return { readiness: "setup-required", detail: `This VM needs ${missing.split(/\s+/).join(" and ")}. Install them (for example apt-get install -y xdotool imagemagick).` };
        if (!result.stdout.includes("display:ok")) return { readiness: "setup-required", detail: `This VM has no desktop on display ${display}. Start one (for example Xvfb ${display}) and try again.` };
        return { readiness: "ready", detail: "Ready" };
      } catch (error) {
        return { readiness: "unavailable", detail: `Could not reach this VM: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async screen() {
      const result = await run("xdotool getdisplaygeometry");
      const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
      if (!width || !height) throw new Error("The VM's display size is unavailable.");
      return { x: 0, y: 0, width, height };
    },
    async windows() {
      const script = `for id in $(xdotool search --onlyvisible --name . 2>/dev/null); do
  eval "$(xdotool getwindowgeometry --shell "$id" 2>/dev/null)" || continue
  [ "\${WIDTH:-0}" -ge 80 ] && [ "\${HEIGHT:-0}" -ge 60 ] || continue
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$X" "$Y" "$WIDTH" "$HEIGHT" "$(xdotool getwindowclassname "$id" 2>/dev/null || echo app)" "$(xdotool getwindowname "$id" 2>/dev/null)"
done`;
      const result = await run(script);
      return result.stdout.split("\n").filter(Boolean).slice(0, 128).map((line) => {
        const [id, x, y, width, height, app, ...title] = line.split("\t");
        return { id: Number(id), app: (app || "app").slice(0, 120), title: title.join("\t").slice(0, 500) || "Untitled window",
          region: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) } };
      }).filter((window) => Number.isSafeInteger(window.id) && window.id > 0 && Object.values(window.region).every(Number.isFinite));
    },
    async focus(windowId) {
      await run(`xdotool windowactivate --sync ${integer(windowId)} 2>/dev/null || xdotool windowfocus ${integer(windowId)}`);
    },
    async screenshot(region, { maxWidth } = {}) {
      const file = `${directory}/shot-${randomUUID().slice(0, 8)}.png`;
      const resize = maxWidth && region.width > maxWidth ? ` -resize ${integer(maxWidth)}x` : "";
      const geometry = `${integer(region.width)}x${integer(region.height)}+${integer(region.x)}+${integer(region.y)}`;
      const result = await run(`mkdir -p ${quote(directory)} && import -silent -window root -crop ${geometry} +repage${resize} png:${quote(file)} && identify -format '%w %h' ${quote(file)}`);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim().slice(0, 300) || "The screenshot failed.");
      const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
      const png = await machine.read(file, timeoutMs);
      void run(`rm -f ${quote(file)}`).catch(() => {});
      return { png, width, height };
    },
    async input(steps) {
      // Lines run in order and stop at the first failure; markers count the finished steps.
      const lines = steps.map((action, index) => `${step(action)} || { echo "failed:${index}"; exit 0; }; echo "done:${index}"`);
      const result = await run(lines.join("\n"));
      const done = [...result.stdout.matchAll(/done:(\d+)/g)].length;
      const failed = result.stdout.match(/failed:(\d+)/);
      return { completed: done, ...(failed ? { error: `Step ${Number(failed[1]) + 1} failed: ${result.stderr.trim().slice(0, 200) || "xdotool refused it"}.` } : {}) };
    },
  };
}
