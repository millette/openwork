// A remote computer (a Linux VM, a cloud desktop) as a computer use adapter.
// It speaks the same seven-tool contract as the macOS helper, so the broker,
// consent, handoff and the floating Computer view work unchanged. Providers
// supply only a small driver: windows, screenshots and input.
import { randomUUID } from "node:crypto";
import { COMPUTER_PROTOCOL } from "./computer-control.mjs";

const SESSION_SECONDS = 900;
const OBSERVATION_MS = 60_000;
const MAX_ACTIONS = 200;
const FRAME_MS = 800;
const WATCH_MS = 1_500;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Region
 * @typedef {{ id: number, title: string, app: string, region: Region }} RemoteWindow
 * @typedef {{
 *   type: string, x?: number, y?: number, text?: string, key?: string, ms?: number,
 *   delta_x?: number, delta_y?: number, modifiers?: string[], path?: Array<{ x: number, y: number }>, ref?: string,
 * }} RemoteAction
 * @typedef {{
 *   platform: "linux",
 *   describe: () => Promise<{ readiness: "ready" | "setup-required" | "unavailable", detail: string }>,
 *   windows: () => Promise<RemoteWindow[]>,
 *   screen: () => Promise<Region>,
 *   focus: (windowId: number) => Promise<void>,
 *   screenshot: (region: Region, options?: { maxWidth?: number }) => Promise<{ png: Uint8Array, width: number, height: number }>,
 *   input: (steps: RemoteAction[]) => Promise<{ completed: number, error?: string }>,
 * }} ComputerDriver
 */

const text = (value, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (code, message, extra = {}) => text({ ok: false, code, message, ...extra }, true);
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * @param {{ id: string, label: string, driver: ComputerDriver, now?: () => number }} options
 */
export function createRemoteComputerAdapter({ id, label, driver, now = Date.now }) {
  return {
    id,
    label,
    placement: /** @type {"remote"} */ ("remote"),
    protocol: COMPUTER_PROTOCOL,
    async readiness() {
      return driver.describe();
    },
    /** @param {{ signal: AbortSignal, onUi: (value: unknown) => void, onClose: () => void }} options */
    async connect({ signal, onUi, onClose }) {
      signal.throwIfAborted();
      let session = null;
      let closed = false;
      let queue = Promise.resolve();
      let inputSequence = 0;
      let frameSequence = 0;
      let watchUntil = 0;
      let frameTimer = null;
      // Driver calls never overlap: frames, observations and input share one line.
      /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
      const serial = (work) => {
        const result = queue.then(work);
        queue = result.then(() => undefined, () => undefined);
        return result;
      };
      const publish = (value) => { if (!closed) onUi(value); };
      const publishState = (phase, extra = {}) => {
        if (!session) return;
        publish({ kind: "state", id: session.uiId, phase, appID: session.appId, appName: session.appName, mode: session.mode, task: session.purpose,
          ...(session.window ? { windowTitle: session.window.title } : {}), ...(phase === "paused" ? { canContinue: true } : {}), ...extra });
      };
      const expiresIn = () => session ? Math.max(0, Math.round((session.expiresAt - now()) / 1000)) : 0;
      const live = () => session && !session.closed && now() < session.expiresAt;
      const status = () => ({ ok: true, session_id: session.id, state: session.paused ? "paused" : "active", app_name: session.appName,
        ...(session.window ? { window_title: session.window.title } : {}), mode: session.mode, purpose: session.purpose, expires_in_seconds: expiresIn(),
        ...(session.paused ? { next: "human_takeover", pause_reason: "The person took over. Wait for them to choose Continue in the Computer view." } : {}) });

      async function refreshWindow() {
        const windows = await driver.windows();
        const match = windows.find((window) => window.id === session.window.id);
        if (!match) throw new Error("The approved window closed.");
        session.window = match;
        return match;
      }

      function scheduleFrames() {
        clearTimeout(frameTimer);
        if (closed || !live() || session.paused || !session.window || now() >= watchUntil) return;
        frameTimer = setTimeout(() => {
          void serial(async () => {
            if (closed || !live() || session.paused || now() >= watchUntil) return;
            const shot = await driver.screenshot(session.window.region, { maxWidth: 960 });
            publish({ kind: "frame", id: session.uiId, sequence: ++frameSequence, capturedAt: now(), width: shot.width, height: shot.height, mimeType: "image/png", data: base64(shot.png) });
          }).catch(() => {}).finally(scheduleFrames);
        }, FRAME_MS);
        frameTimer.unref?.();
      }

      function close(reason) {
        if (!session || session.closed) return;
        session.closed = true;
        session.decide?.({ action: "deny" });
        publishState("closed", { status: reason });
        clearTimeout(frameTimer);
      }

      // Image pixels of an observation map back to screen pixels of its window.
      const toScreen = (observation, x, y) => ({
        x: Math.round(observation.region.x + x * observation.scale),
        y: Math.round(observation.region.y + y * observation.scale),
      });

      const tools = {
        async computer_discover() {
          const windows = await serial(() => driver.windows());
          const apps = new Map([["desktop", { app_id: "desktop", name: "Whole screen", windows: 1 }]]);
          for (const window of windows) {
            const entry = apps.get(window.app) ?? { app_id: window.app, name: window.app, windows: 0 };
            entry.windows++;
            apps.set(window.app, entry);
          }
          return text({ ok: true, protocol: COMPUTER_PROTOCOL, computer: label, platform: driver.platform, apps: [...apps.values()],
            modes: ["observe", "control"], permissions: { accessibility: true, screenRecording: true },
            keyboard: { modifiers: ["control", "shift", "option", "command"], note: "Linux: use control for shortcuts; command is sent as control, option as alt." },
            limits: { session_seconds: SESSION_SECONDS, actions: MAX_ACTIONS, batch: 8, observation_seconds: OBSERVATION_MS / 1000 },
            note: "This computer has no accessibility tree: act with coordinates from the observation image." });
        },
        async computer_open_session(args, options) {
          if (live()) return failure("session_open", "A session is already open. Keep using it, or close it first. Nothing was dispatched.");
          if (args.mode === "assist") return failure("mode_unsupported", "This computer has no accessibility controls. Use control (mouse and keyboard) or observe. Nothing was dispatched.");
          const windows = args.app_id === "desktop"
            ? [{ id: 1, title: "Whole screen", app: "desktop", region: await serial(() => driver.screen()), whole: true }]
            : (await serial(() => driver.windows())).filter((window) => window.app === args.app_id);
          if (!windows.length) return failure("app_not_found", "That app has no open window on this computer. Call computer_discover again. Nothing was dispatched.");
          session = { id: randomUUID(), uiId: randomUUID(), appId: args.app_id, appName: args.app_id === "desktop" ? "Whole screen" : args.app_id, mode: args.mode,
            purpose: args.purpose, window: null, paused: false, closed: false, expiresAt: now() + SESSION_SECONDS * 1000, actions: 0,
            observations: new Map(), receipts: new Map(), decide: null };
          const current = session;
          // The broker approves a single or remembered window itself; otherwise the person chooses in the Computer view.
          const decision = await new Promise((resolve, reject) => {
            current.decide = resolve;
            const abort = () => reject(options.signal.reason);
            options.signal.addEventListener("abort", abort, { once: true });
            publish({ kind: "state", id: current.uiId, phase: "approval", appID: current.appId, ...(args.pid ? { pid: args.pid } : {}), appName: current.appName,
              mode: current.mode, task: current.purpose, windows: windows.map(({ id, title }) => ({ id, title })) });
          }).finally(() => { current.decide = null; });
          if (decision.action !== "approve" || current.closed) {
            session = null;
            return failure("access_denied", "The person did not approve a window. Nothing was dispatched. Do not retry unless they ask.");
          }
          current.window = windows.find((window) => window.id === decision.windowId) ?? windows[0];
          if (!current.window.whole) await serial(() => driver.focus(current.window.id));
          publishState("working");
          return text({ ...status(), ok: true, state: "active" });
        },
        async computer_observe(args) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open. Call computer_open first.");
          if (session.paused) return text({ ...status(), ok: false, code: "paused" }, true);
          const window = session.window.whole ? session.window : await serial(refreshWindow);
          const shot = await serial(() => driver.screenshot(window.region, { maxWidth: 1600 }));
          const observationId = randomUUID();
          session.observations.set(observationId, { at: now(), region: window.region, scale: window.region.width / shot.width, width: shot.width, height: shot.height });
          for (const key of [...session.observations.keys()].slice(0, -8)) session.observations.delete(key);
          return { content: [
            { type: "text", text: JSON.stringify({ ok: true, observation_id: observationId, width: shot.width, height: shot.height, window_title: window.title,
              elements: [], expires_in_seconds: OBSERVATION_MS / 1000, note: "Coordinates are image pixels of this observation." }) },
            ...(args.include_image === false ? [] : [{ type: "image", data: base64(shot.png), mimeType: "image/png" }]),
          ] };
        },
        async computer_zoom(args) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open. Call computer_open first.");
          const observation = session.observations.get(args.observation_id);
          if (!observation || now() - observation.at > OBSERVATION_MS) return failure("observation_expired", "Observe again before zooming.");
          const start = toScreen(observation, args.x, args.y);
          const region = { x: start.x, y: start.y, width: Math.max(8, Math.round(args.width * observation.scale)), height: Math.max(8, Math.round(args.height * observation.scale)) };
          const shot = await serial(() => driver.screenshot(region));
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, observation_id: args.observation_id, width: shot.width, height: shot.height }) }, { type: "image", data: base64(shot.png), mimeType: "image/png" }] };
        },
        async computer_act(args) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open. Call computer_open first.");
          if (session.paused) return text({ ...status(), ok: false, code: "paused" }, true);
          if (session.mode === "observe") return failure("mode_unsupported", "This session can only observe. Close it and open one in control mode.");
          // At most once: a repeated request returns its first receipt.
          const previous = session.receipts.get(args.request_id);
          if (previous) return previous;
          const observation = session.observations.get(args.observation_id);
          if (!observation || now() - observation.at > OBSERVATION_MS) return failure("observation_expired", "That observation expired. Observe again; nothing was dispatched.");
          session.observations.delete(args.observation_id);
          const actions = args.actions ?? [args.action];
          if (session.actions + actions.length > MAX_ACTIONS) return failure("action_limit", "This session reached its action limit. Close it and open a new one.");
          if (actions.some((action) => action.type === "press" || action.type === "set_value")) {
            return failure("unsupported_action", "This computer has no accessibility refs. Use click and type with image coordinates. Nothing was dispatched.");
          }
          const steps = actions.map((action) => {
            const point = action.x !== undefined && action.y !== undefined ? toScreen(observation, action.x, action.y) : null;
            return { ...action, ...(point ?? {}), ...(action.path ? { path: action.path.map((step) => toScreen(observation, step.x, step.y)) } : {}) };
          });
          session.actions += actions.length;
          const result = await serial(() => driver.input(steps));
          for (const action of actions.slice(0, Math.max(1, result.completed))) {
            const x = action.x !== undefined ? action.x / observation.width : action.path?.at(-1) ? action.path.at(-1).x / observation.width : undefined;
            const y = action.y !== undefined ? action.y / observation.height : action.path?.at(-1) ? action.path.at(-1).y / observation.height : undefined;
            publish({ kind: "input", id: session.uiId, sequence: ++inputSequence, at: now(), action: action.type === "wait" ? "move" : action.type, phase: "dispatched",
              ...(x !== undefined && x >= 0 && x <= 1 ? { x } : {}), ...(y !== undefined && y >= 0 && y <= 1 ? { y } : {}) });
          }
          const receipt = result.completed === actions.length
            ? text({ ok: true, status: "dispatched", completed: actions.length, next: "observe" })
            : text({ ok: true, status: "partial", completed: result.completed, failed: result.completed, skipped: actions.length - result.completed - 1,
              may_have_acted: result.completed > 0, next: "observe", message: result.error ?? "A step failed." });
          session.receipts.set(args.request_id, receipt);
          return receipt;
        },
        async computer_session_status(args) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open.");
          return text(status());
        },
        async computer_close_session(args) {
          if (!session || args.session_id !== session.id) return failure("session_unavailable", "No session is open.");
          close("Closed by the agent.");
          session = null;
          return text({ ok: true, state: "closed" });
        },
      };

      return {
        async callTool(name, args, options = {}) {
          if (closed) throw new Error(`${label} is disconnected.`);
          const tool = Object.hasOwn(tools, name) ? tools[name] : null;
          if (!tool) return failure("unknown_tool", "This computer tool does not exist.");
          const callSignal = options.signal ?? new AbortController().signal;
          try {
            return await tool(args ?? {}, { signal: callSignal });
          } catch (error) {
            if (callSignal.aborted) throw error;
            return failure("computer_failed", `${label} could not complete this: ${error instanceof Error ? error.message : String(error)}. Do not replay input; observe first.`);
          }
        },
        /** @param {{ id?: unknown, action?: unknown, windowId?: unknown, visible?: unknown }} params */
        async notifyUi({ id: uiId, action, windowId, visible }) {
          if (!session || session.uiId !== uiId) return;
          if (action === "approve" || action === "deny") { session.decide?.({ action, windowId }); return; }
          if (action === "watch") { watchUntil = visible ? now() + WATCH_MS : 0; scheduleFrames(); return; }
          if (action === "takeover" && !session.paused) { session.paused = true; publishState("paused"); return; }
          if (action === "resume" && session.paused) { session.paused = false; session.observations.clear(); publishState("working"); return; }
          if (action === "stop") close("Stopped by the person.");
        },
        async close() {
          if (closed) return;
          close("Computer use ended.");
          closed = true;
          clearTimeout(frameTimer);
          await queue;
          onClose();
        },
      };
    },
  };
}
