// The computer broker owns per-chat consent, the single native session lease,
// receipts, observations and handoff. Model arguments never select a session,
// window, receipt identity, helper command or credential.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export const COMPUTER_TOOLS = Object.freeze({
  computer_discover: "computer_discover",
  computer_open: "computer_open_session",
  computer_observe: "computer_observe",
  computer_act: "computer_act",
  computer_zoom: "computer_zoom",
  computer_status: "computer_session_status",
  computer_close: "computer_close_session",
});
export const COMPUTER_PROTOCOL = "openwork.computer-use/1";
export const COMPUTER_STOP_GUIDANCE = "Computer session revocation could not be confirmed. Use Stop on the agent's pill over the app window or in the OpenWork Computer Use menu before continuing.";
const ARGUMENTS = Object.freeze({
  computer_open: ["app_id", "pid", "mode", "purpose"],
  computer_observe: ["include_image", "elements"],
  computer_act: ["observation_id", "action", "actions", "intent"],
  computer_zoom: ["observation_id", "x", "y", "width", "height"],
});
const failure = (code, message, extra = {}) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, message, ...extra }) }] });
const stateOf = (result) => {
  try { return JSON.parse(result.content.find((part) => part.type === "text").text); } catch { return null; }
};
const needsPerson = (result) => stateOf(result)?.state === "paused" || stateOf(result)?.next === "human_takeover";
const withHandoff = (result, status) => {
  const state = stateOf(status);
  const continued = !status.isError && state?.ok === true && state.state === "active";
  return { ...result, isError: result.isError === true || !continued,
    content: [...result.content, { type: "text", text: JSON.stringify({ handoff: state, next: continued ? "observe" : "human_takeover", fresh_observation_required: true, actions_replayed: false }) }] };
};
const withPostObservation = (receipt, status, content = []) => ({ ...receipt, content: [...receipt.content,
  { type: "text", text: JSON.stringify({ post_observation: status, actions_replayed: false,
    ...(!status.ok ? { next: status.next, fresh_observation_required: true } : {}) }) }, ...content] });
const postWarning = (receipt, code, next = "observe") => withPostObservation(receipt, { ok: false, code, next,
  message: "The fresh observation is unavailable. The original receipt is unchanged; do not replay the input. Review the current control state before observing again." });
// A call made in the wrong order dispatched nothing: report it without revoking or closing anything.
const SEQUENCE_CODES = new Set(["session_open", "session_required"]);
const uiText = (value, limit) => typeof value === "string" && value.length <= limit;
const uiNumber = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Computer cleanup or operation timed out.")), ms); })]); }
  finally { clearTimeout(timer); }
}

function deadline(ms) {
  const controller = new AbortController();
  const { signal } = controller;
  const expires = performance.now() + ms;
  const expire = () => controller.abort(new Error("Computer cleanup or operation timed out."));
  const timer = setTimeout(expire, ms);
  const check = () => { if (performance.now() >= expires) expire(); signal.throwIfAborted(); };
  return { signal, check, dispose: () => clearTimeout(timer), async wait(work, parent = signal) {
    const pending = parent === signal ? signal : AbortSignal.any([signal, parent]);
    const active = () => { check(); pending.throwIfAborted(); };
    active();
    let abort;
    try {
      const stopped = new Promise((_, reject) => { abort = () => reject(pending.reason); pending.addEventListener("abort", abort, { once: true }); });
      const value = await Promise.race([Promise.resolve().then(() => { active(); return work(pending); }), stopped]);
      active();
      return value;
    } finally { pending.removeEventListener("abort", abort); }
  } };
}

/**
 * @typedef {{ isError?: boolean, content: Array<{ type: string, text?: string, data?: string, mimeType?: string }> }} ComputerResult
 * @typedef {{ sessionId?: string }} ChatInput
 * @typedef {{
 *   callTool: (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<ComputerResult>,
 *   notifyUi: (params: Record<string, unknown>) => Promise<void>,
 *   close: () => Promise<void>,
 * }} ComputerTransport
 * @typedef {{
 *   protocol: string,
 *   readiness: () => Promise<{ readiness: string, detail: string, permissions?: { accessibility: boolean, screenRecording: boolean } }>,
 *   setup: (permission: "accessibility" | "screenRecording") => Promise<{ setupId: string }>,
 *   dismissSetup?: (setupId?: string) => Promise<void>,
 *   connect: (options: { signal: AbortSignal, presence: { name: string, color: string } | null, onUi: (value: unknown) => void, onClose: () => void }) => Promise<ComputerTransport>,
 * }} ComputerAdapter
 */

/**
 * The adapter is a trusted main-process dependency, never renderer or model
 * input. connect() owns a dedicated native session scope; close() MUST confirm
 * session revocation, not merely disconnect. One controller across all chats.
 * `standing` is the person's saved "Always allow", stored outside every
 * workspace so an agent can never grant itself access.
 * @param {{
 *   adapter: ComputerAdapter,
 *   standing?: { allowed: () => Promise<boolean>, set: (allowed: boolean) => Promise<void> },
 *   presence?: { name: string, color: string } | null,
 *   cleanupMs?: number, operationMs?: number, pollMs?: number, idleMs?: number, now?: () => number,
 * }} options
 */
export function createComputerControl({ adapter, standing = { allowed: async () => false, set: async (_allowed) => {} }, presence = null,
  cleanupMs = 3000, operationMs = 120_000, pollMs = 750, idleMs = 90_000, now = Date.now }) {
  if (!adapter || adapter.protocol !== COMPUTER_PROTOCOL || ["readiness", "setup", "connect"].some((name) => typeof adapter[name] !== "function")) {
    throw new Error("A trusted computer adapter with the supported protocol is required.");
  }
  for (const value of [cleanupMs, operationMs, pollMs, idleMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Computer time limits must be positive bounded milliseconds.");
  const grants = new Map();
  let lease = null;
  let tail = Promise.resolve();
  let closed = false;
  let resetting = 0;
  function invalidateObservation(current) {
    current.observationGeneration = (current.observationGeneration ?? 0) + 1;
  }
  function advance(grant) {
    grant.controller.abort(new Error("Computer use was turned off, revoked, or restarted."));
    grant.controller = new AbortController();
    return ++grant.revision;
  }
  function disable(grant) {
    grant.enabled = false; advance(grant);
    if (lease?.grant === grant) invalidateObservation(lease);
  }
  const standingAllowed = () => Promise.resolve().then(() => standing.allowed()).then((value) => value === true, () => false);
  // Always allow re-arms automatic safety stops at the next turn boundary.
  // The person's own Stop, Deny, or Off keeps that chat off until re-enabled.
  async function rearm(sessionId) {
    if (closed || resetting || !await standingAllowed()) return;
    for (const grant of grants.values()) {
      if (sessionId && grant.sessionId !== sessionId) continue;
      if (!grant.enabled && !grant.personOff && lease?.grant !== grant) grant.enabled = true;
    }
  }
  const serial = (work, limit, signal) => {
    const previous = tail;
    const ready = limit ? limit.wait(() => previous, signal) : previous;
    const result = ready.then(() => { limit?.check(); signal?.throwIfAborted(); return work(); });
    tail = Promise.all([previous, result.then(() => undefined, () => undefined)]).then(() => undefined);
    return result;
  };
  async function grantFor(sessionId) {
    if (closed || resetting) throw new Error("Computer use is stopping.");
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("A chat is required.");
    let grant = grants.get(sessionId);
    if (!grant) {
      const allowed = await standingAllowed();
      grant = grants.get(sessionId);
      if (!grant) {
        grant = { sessionId, revision: 0, controller: new AbortController(), enabled: allowed, personOff: false };
        grants.set(sessionId, grant);
      }
    }
    return grant;
  }
  async function readiness() {
    try {
      const status = await bounded(adapter.readiness(), cleanupMs);
      if (!["ready", "setup-required", "unsupported", "unavailable"].includes(status?.readiness) || typeof status.detail !== "string") throw new Error("Invalid readiness.");
      const permissions = status.permissions;
      if (permissions !== undefined && (typeof permissions?.accessibility !== "boolean" || typeof permissions?.screenRecording !== "boolean")) throw new Error("Invalid permissions.");
      return { readiness: status.readiness, detail: status.detail,
        ...(permissions ? { permissions: { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording } } : {}) };
    } catch { return { readiness: "unavailable", detail: "Computer use is unavailable on this Mac." }; }
  }
  function revise(grant, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== grant.revision) throw new Error("Computer settings changed. Check the latest state before trying again.");
    return advance(grant);
  }
  function clearPresentation(current) {
    invalidateObservation(current);
    current.presentation = null;
    current.watchUntil = 0;
    current.frameSequence = -1;
    current.inputSequence = -1;
  }
  function assertUiActive(current) {
    if (lease !== current || current.closing || current.uiEnded || !current.grant.enabled
      || current.controller.signal.aborted || (current.expiresAt !== undefined && now() >= current.expiresAt)) {
      throw new Error("This computer session ended. Sensitive actions still require your authorization.");
    }
  }
  function controlStillOwned(call, observation) {
    const { current, generation, nativeId } = observation;
    try { assertUiActive(current); } catch { return false; }
    return call.grant.revision === call.revision && current.nativeId === nativeId && current.handoffGeneration === generation
      && current.presentation?.phase !== "paused";
  }
  function observationStillOwned(call, observation) {
    return controlStillOwned(call, observation) && observation.current.observationGeneration === observation.observationGeneration;
  }
  function postStillOwned(call) {
    return observationStillOwned(call, call.post) && call.post.current.session?.state !== "paused";
  }
  function observationWarning(call, observation) {
    if (observation.current.observationGeneration === observation.observationGeneration) observation.current.needsObservation = true;
    return failure("observation_required", "Computer control changed while observing. The previous observation was withheld. Review the native controls and observe again.",
      { next: controlStillOwned(call, observation) ? "observe" : "human_takeover", fresh_observation_required: true, actions_replayed: false });
  }
  // A late read must not deliver an image or unlock input after a takeover,
  // even when the person already continued before it arrived.
  function deliverResult(call, result) {
    if (call.post?.captured) return postStillOwned(call) ? call.post.result : postWarning(call.post.receipt, "observation_withheld", controlStillOwned(call, call.post) ? "observe" : "human_takeover");
    if (call.observation && !result.isError) return observationStillOwned(call, call.observation) ? result : observationWarning(call, call.observation);
    return result;
  }
  function matchesOpening(current, value) {
    const opening = current.opening;
    return opening && !opening.signal.aborted && value.appID === opening.args.app_id
      && (opening.args.pid === undefined || value.pid === opening.args.pid)
      && value.mode === opening.args.mode && value.task === opening.args.purpose;
  }
  async function approveWindow(current, presentation, windowId) {
    const opening = current.opening;
    if (!opening || opening.decisionSent) throw new Error("This app request already has a decision. Do not retry it.");
    // Reserve the decision before any await so duplicate notifications cannot approve twice.
    opening.decisionSent = true;
    assertUiActive(current);
    opening.assertActive();
    if (current.presentation !== presentation || presentation.phase !== "approval"
      || !presentation.windows.some((window) => window.id === windowId)) throw new Error("The native window choice changed. Review it again.");
    await current.transport.notifyUi({ id: presentation.id, action: "approve", windowId });
  }
  function receiveUi(current, value) {
    try { assertUiActive(current); } catch { clearPresentation(current); return; }
    if (!value || !uiText(value.id, 128) || !value.id || !["state", "frame", "input"].includes(value.kind)) return;
    const presentation = current.presentation;
    if (value.kind === "state") {
      if (!["approval", "working", "paused", "closed"].includes(value.phase)) return;
      // Only the exact admitted open can introduce an identity. Never adopt a
      // different native ID on this lease, even if a late notification looks valid.
      if (current.uiId && value.id !== current.uiId) {
        clearPresentation(current); current.uiEnded = true;
        disable(current.grant); void cleanup(current);
        return;
      }
      if (!current.uiId && (value.phase !== "approval" || !matchesOpening(current, value))) return;
      if (value.phase === "closed") {
        clearPresentation(current); current.uiEnded = true;
        if (!current.expectedClose) { disable(current.grant); void cleanup(current); }
        return;
      }
      for (const [key, limit] of [["appName", 512], ["appID", 512], ["windowTitle", 2048], ["task", 500], ["mode", 32], ["status", 2048]]) {
        if (value[key] !== undefined && !uiText(value[key], limit)) return;
      }
      if (value.pid !== undefined && (!uiNumber(value.pid, 0x7fffffff) || value.pid === 0)) return;
      if (value.canContinue !== undefined && typeof value.canContinue !== "boolean") return;
      if (value.windows !== undefined && (!Array.isArray(value.windows) || value.windows.length > 128
        || value.windows.some((window) => !window || !uiNumber(window.id, 0xffffffff) || !window.id || !uiText(window.title, 2048))
        || new Set(value.windows.map((window) => window.id)).size !== value.windows.length)) return;
      if (value.phase === "approval" && (!matchesOpening(current, value) || !Array.isArray(value.windows) || !value.windows.length)) return;
      if (!current.uiId) { clearPresentation(current); current.uiId = value.id; }
      const next = { id: value.id, phase: value.phase, inputs: presentation?.inputs ?? [] };
      for (const key of ["appName", "windowTitle", "task", "mode", "status", "canContinue"]) if (value[key] !== undefined) next[key] = value[key];
      if (value.windows) next.windows = value.windows.map(({ id, title }) => ({ id, title }));
      if (value.phase === "working" && presentation?.frame) next.frame = presentation.frame;
      if (value.phase === "paused") {
        if (presentation?.phase !== "paused") current.handoffGeneration++;
        invalidateObservation(current);
        current.needsObservation = true; next.inputs = [];
      }
      if (value.phase === "approval" && isDeepStrictEqual(presentation, next)) return;
      current.presentation = next;
      if (value.phase === "approval" && value.windows.length === 1 && !current.opening.decisionSent) {
        void approveWindow(current, next, value.windows[0].id).catch(() => {
          // An uncertain decision is never resent or converted into a new request.
          if (lease === current && !current.closing) { disable(current.grant); void cleanup(current); }
        });
      }
      return;
    }
    if (!presentation || value.id !== presentation.id || presentation.phase !== "working" || current.watchUntil <= now()) return;
    if (!uiNumber(value.sequence)) return;
    if (value.kind === "frame") {
      if (value.sequence <= current.frameSequence || !uiNumber(value.capturedAt)
        || !uiNumber(value.width, 8192) || !value.width || !uiNumber(value.height, 8192) || !value.height || value.width * value.height > 16_777_216
        || value.mimeType !== "image/png" || !uiText(value.data, 4 * 1024 * 1024) || !value.data.startsWith("iVBORw0KGgo")
        || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return;
      current.frameSequence = value.sequence;
      presentation.frame = { sequence: value.sequence, capturedAt: value.capturedAt, width: value.width, height: value.height, mimeType: "image/png", data: value.data };
    } else {
      if (value.sequence <= current.inputSequence || !uiNumber(value.at)
        || !["move", "click", "double_click", "triple_click", "drag", "scroll", "key", "type", "press", "set_value"].includes(value.action)
        || !["move", "down", "up", "dispatched", "uncertain"].includes(value.phase)
        || [value.x, value.y].some((position) => position !== undefined && (!Number.isFinite(position) || position < 0 || position > 1))) return;
      current.inputSequence = value.sequence;
      presentation.inputs.push({ sequence: value.sequence, at: value.at, action: value.action, phase: value.phase,
        ...(value.x !== undefined ? { x: value.x } : {}), ...(value.y !== undefined ? { y: value.y } : {}) });
      if (presentation.inputs.length > 64) presentation.inputs.shift();
    }
  }
  function updateSession(current, result, purpose) {
    const state = stateOf(result);
    if (!state) return;
    const paused = state.state === "paused" || state.next === "human_takeover";
    if (paused && current.nativeId) { invalidateObservation(current); current.needsObservation = true; }
    if ((result.isError || state.ok !== true) && !paused) return;
    const opening = current.session?.state === "opening";
    if (Number.isFinite(state.expires_in_seconds)) current.expiresAt = now() + Math.max(0, state.expires_in_seconds) * 1000;
    current.session = {
      ...current.session,
      state: paused ? "paused" : state.state ?? current.session?.state ?? "active",
      purpose: purpose ?? state.purpose ?? current.session?.purpose ?? "",
      ...(typeof state.app_name === "string" ? { appName: state.app_name } : {}),
      ...(typeof state.window_title === "string" ? { windowTitle: state.window_title } : {}),
      ...(typeof state.phase === "string" ? { phase: state.phase } : paused ? { phase: "waiting-for-person" } : {}),
      ...(Number.isFinite(state.expires_in_seconds) ? { expiresAt: new Date(now() + state.expires_in_seconds * 1000).toISOString() } : {}),
      reason: typeof state.pause_reason === "string" ? state.pause_reason : paused ? state.message ?? "Continue or Stop in the native computer controls." : "",
    };
    if (!paused && (opening || state.state === "active") && typeof state.phase !== "string") delete current.session.phase;
  }
  function nativeStopped(current, result) {
    if (stateOf(result)?.code !== "session_unavailable") return false;
    disable(current.grant);
    current.nativeStopped = true;
    return true;
  }
  async function cleanup(current) {
    clearTimeout(current.idleTimer);
    current.closing = true;
    clearPresentation(current);
    current.opening = null;
    current.controller.abort(new Error("Computer control stopped."));
    current.cleanupPending = true;
    if (!current.cleanup) {
      current.cleanup = (async () => {
        // Do not free the machine while an open/connect may still acknowledge late.
        await current.work?.catch(() => {});
        if (current.connectionUncertain && !current.transport) throw new Error("Connection setup failed without a confirmed helper shutdown.");
        if (current.transport && !current.transportClosed) {
          if (current.nativeId) {
            try { nativeStopped(current, await bounded(current.transport.callTool("computer_close_session", { session_id: current.nativeId }), cleanupMs)); }
            catch { /* close() below must still confirm session revocation. */ }
          }
          await bounded(current.transport.close(), cleanupMs);
          current.transportClosed = true;
        }
        current.cleanupPending = false;
        if (lease === current) lease = null;
        return true;
      })().catch(() => false).finally(() => { current.cleanup = null; });
    }
    try { return await bounded(current.cleanup, cleanupMs); }
    catch {
      // Closing the dedicated transport also cancels a native approval sheet.
      // Keep the reservation until the in-flight operation actually settles.
      if (current.transport && !current.transportClosed) {
        try { await bounded(current.transport.close(), cleanupMs); current.transportClosed = true; } catch { /* Still uncertain; Stop can retry cleanup. */ }
      }
      return !current.cleanupPending;
    }
  }
  // An idle or finished session hands the Mac back without turning the chat off.
  async function release(current) {
    if (lease !== current || current.busy || current.closing) return true;
    current.expectedClose = true;
    const confirmed = await cleanup(current);
    await rearm(current.grant.sessionId);
    return confirmed;
  }
  function armIdleRelease(current) {
    clearTimeout(current.idleTimer);
    if (lease !== current || current.busy || current.closing) return;
    current.idleTimer = setTimeout(() => { void release(current); }, idleMs);
    current.idleTimer.unref?.();
  }
  async function view(grant, poll = false) {
    if (poll && lease?.grant === grant && lease.nativeId && !lease.closing && !lease.busy) {
      const limit = deadline(cleanupMs);
      try {
        await serial(async () => {
          const current = lease;
          if (current?.grant !== grant || current.closing || !current.nativeId || current.busy) return;
          const revision = grant.revision;
          const signal = AbortSignal.any([limit.signal, current.controller.signal]);
          current.work = current.transport.callTool("computer_session_status", { session_id: current.nativeId }, { signal });
          try {
            const result = await limit.wait(() => current.work, signal);
            if (lease !== current || current.closing || grant.revision !== revision) return;
            if (nativeStopped(current, result)) {
              await cleanup(current);
            } else if (result.isError || stateOf(result)?.ok !== true) {
              current.session = { ...current.session, state: "unavailable", reason: stateOf(result)?.message ?? "Native status is unavailable." };
            } else updateSession(current, result);
          } catch {
            if (lease === current && grant.revision === revision) disable(grant);
            await cleanup(current);
          }
        }, limit);
      } catch { /* The snapshot below reports the last known state. */ }
      finally { limit.dispose(); }
    }
    const status = await readiness();
    const elsewhere = lease && lease.grant !== grant;
    const current = lease?.grant === grant ? lease : null;
    return {
      revision: grant.revision, enabled: grant.enabled, alwaysAllowed: await standingAllowed(),
      readiness: status.readiness, ...(status.permissions ? { permissions: status.permissions } : {}),
      detail: current?.cleanupPending ? "Stopping computer use. Native release has not yet been confirmed." : status.detail,
      busyElsewhere: Boolean(elsewhere),
      session: current?.session ? { ...current.session, ...(current.closing ? { state: "stopping" } : {}) } : null,
      ...(current?.cleanupPending ? { cleanupPending: true } : {}),
    };
  }
  async function run(call, signal, limit) {
    const { name, args, grant, revision } = call;
    const check = () => {
      if (closed || resetting || !grant.enabled || grant.revision !== revision || grants.get(grant.sessionId) !== grant) {
        throw new Error("Computer use was turned off, revoked, or restarted before this call finished.");
      }
    };
    const admissionSignal = AbortSignal.any([limit.signal, signal, grant.controller.signal]);
    return serial(async () => {
      limit.check(); check();
      if (lease && (lease.grant !== grant || lease.closing)) {
        return failure("computer_busy", lease.closing
          ? "The previous computer session is still stopping. Try again in a moment. Nothing was dispatched."
          : "Another chat is using this Mac. It must finish or be stopped first. Nothing was dispatched.");
      }
      lease ??= { grant, controller: new AbortController(), nativeId: null, session: null, busy: false, handoffGeneration: 0 };
      const current = lease;
      clearTimeout(current.idleTimer);
      current.busy = true;
      // The engine cancelled this tool: end the native session, keep the chat's permission.
      const abort = () => { if (lease === current) { current.expectedClose = true; void cleanup(current); } };
      signal.addEventListener("abort", abort, { once: true });
      const active = AbortSignal.any([admissionSignal, current.controller.signal]);
      const progress = () => { limit.check(); active.throwIfAborted(); check(); };
      /** @type {ComputerResult | undefined} */
      let nativeResult;
      let handoff = false;
      let postReadFailed = false;
      current.work = Promise.resolve().then(async () => {
        progress();
        if (!current.transport) {
          try {
            current.transport = await adapter.connect({
              signal: active, presence,
              onUi: (value) => receiveUi(current, value),
              onClose: () => {
                clearPresentation(current); current.uiEnded = true;
                if (lease === current && !current.closing && !current.expectedClose) { disable(grant); void cleanup(current); }
              },
            });
          } catch (error) {
            // The adapter combines setup and shutdown errors when it could
            // not confirm termination and cannot return a usable handle.
            current.connectionUncertain = error instanceof AggregateError;
            throw error;
          }
          progress();
        }
        if (name === "computer_open" && current.nativeId) return failure("session_open", "A session is already open. Keep using it, or close it before requesting another app or mode. Nothing was dispatched.");
        if (!["computer_discover", "computer_open"].includes(name) && !current.nativeId) return failure("session_required", "No session is open. Call computer_open first. Nothing was dispatched.");
        if (name === "computer_open") {
          current.session = { state: "opening", purpose: args.purpose, phase: "native-approval" };
          current.opening = { args, signal: active, assertActive: progress, decisionSent: false };
        }
        current.expectedClose = name === "computer_close";
        const nativeArgs = { ...args, ...(current.nativeId && name !== "computer_discover" ? { session_id: current.nativeId } : {}),
          ...(name === "computer_act" ? { request_id: randomUUID() } : {}) };
        if (["computer_open", "computer_observe", "computer_act", "computer_close"].includes(name)) invalidateObservation(current);
        const generation = current.handoffGeneration;
        const observationGeneration = current.observationGeneration;
        progress();
        const result = name === "computer_act" && current.needsObservation
          ? failure("observation_required", "Native control paused or continued. Make a fresh observation before any action; no action was dispatched.", current.session?.state === "paused" ? { state: "paused", next: "human_takeover" } : {})
          : (nativeResult = await current.transport.callTool(COMPUTER_TOOLS[name], nativeArgs, { signal: active }));
        const state = stateOf(result);
        if (name === "computer_open") current.opening = null;
        if (name === "computer_open" && typeof state?.session_id === "string") current.nativeId = state.session_id;
        if (!state || typeof state.ok !== "boolean") throw new Error("The native computer response was unreadable; its outcome is uncertain.");
        if (name === "computer_open" && state.ok && !current.nativeId) throw new Error("The native approval returned no session identity.");
        const inputLanded = name === "computer_act" && (!result.isError && state.ok && state.status === "dispatched"
          || state.status === "partial" && state.may_have_acted === true && state.next === "observe");
        if (current.nativeId && (inputLanded || name === "computer_open" && !result.isError && state.ok && state.state === "active")) {
          call.post = { current, generation, nativeId: current.nativeId, receipt: result, captured: false,
            observationGeneration: name === "computer_open" ? current.observationGeneration : observationGeneration };
        }
        progress();
        if (nativeStopped(current, result)) return result;
        // A zoom image follows the same withholding as an observation, but never unlocks input.
        if ((name === "computer_observe" || name === "computer_zoom") && !result.isError && state.ok && !needsPerson(result)) {
          call.observation = { current, generation, nativeId: current.nativeId, observationGeneration };
          if (!observationStillOwned(call, call.observation)) return observationWarning(call, call.observation);
        }
        if (name !== "computer_discover") updateSession(current, result, name === "computer_open" ? args.purpose : undefined);
        if (!current.nativeId || name === "computer_close" || (!needsPerson(result) && current.session?.state !== "paused")) {
          if (name === "computer_observe" && !result.isError && state.ok && typeof state.observation_id === "string") current.needsObservation = false;
          // A partial batch (later step refused) still landed input; the model
          // needs the settled view exactly as much as after a full dispatch.
          if (call.post) {
            try {
              progress(); assertUiActive(current);
              if (!postStillOwned(call) || current.needsObservation) return postWarning(result, "handoff_required", "human_takeover");
              // One read in this exact tool call, never a repeated input or a
              // continuation across a person takeover. Watch frames are unrelated.
              const observation = await current.transport.callTool("computer_observe", { session_id: current.nativeId, include_image: true }, { signal: active });
              progress(); assertUiActive(current);
              if (!postStillOwned(call)) return postWarning(result, "observation_withheld", "human_takeover");
              const observed = stateOf(observation);
              if (observation.isError || observed?.ok !== true || typeof observed.observation_id !== "string" || !observed.observation_id || needsPerson(observation)) {
                current.needsObservation = true;
                nativeStopped(current, observation); updateSession(current, observation);
                const code = typeof observed?.code === "string" && /^[a-z0-9_]{1,80}$/.test(observed.code) ? observed.code : "post_observation_failed";
                return postWarning(result, code, needsPerson(observation) ? "human_takeover" : "observe");
              }
              updateSession(current, observation);
              current.needsObservation = false;
              call.post.captured = true;
              call.post.result = withPostObservation(result, { ok: true }, observation.content);
              return result;
            } catch {
              current.needsObservation = true;
              postReadFailed = true;
              return postWarning(result, "post_observation_failed", "human_takeover");
            }
          }
          return result;
        }
        // Keep the original native tool active while the person decides.
        // Only status reads follow Continue: never resume or redispatch input.
        handoff = true;
        let status = result;
        do {
          current.needsObservation = true;
          updateSession(current, status);
          await delay(pollMs, undefined, { signal: active });
          progress();
          status = await current.transport.callTool("computer_session_status", { session_id: current.nativeId }, { signal: active });
          progress();
          if (nativeStopped(current, status)) break;
          updateSession(current, status);
        } while (needsPerson(status));
        const continued = stateOf(status);
        current.handoffFailed = status.isError === true || continued?.ok !== true;
        if (!current.handoffFailed && continued.state !== "active") throw new Error("The native handoff did not confirm active control.");
        if (name === "computer_act" || result.isError) return withHandoff(result, status);
        if (current.handoffFailed) return status;
        if (name === "computer_observe" || name === "computer_zoom") return withHandoff(failure("observation_required", "The previous observation predates the handoff. Observe again."), status);
        return { ...status, content: [{ type: "text", text: JSON.stringify({ ...state, ...continued, next: "observe", fresh_observation_required: true }) }] };
      });
      const work = current.work;
      const settled = () => { if (current.work === work) current.work = null; };
      void work.then(settled, settled);
      try {
        const result = await limit.wait(() => work);
        if (name === "computer_close" || current.nativeStopped || current.handoffFailed || postReadFailed
          || (name === "computer_open" && result.isError && !SEQUENCE_CODES.has(stateOf(result)?.code))) {
          // An app that would not open stays retryable; the person's denial or
          // native Stop still turns the chat off.
          const retryable = name === "computer_open" && result.isError && !current.nativeStopped
            && !["access_denied", "session_unavailable"].includes(stateOf(result)?.code);
          if (name !== "computer_close" && lease === current && grant.revision === revision && !retryable) disable(grant);
          if (stateOf(result)?.ok === true && name === "computer_close") current.nativeId = null;
          await cleanup(current);
        }
        if (result.isError) return result;
        // Preserve a dispatched or uncertain native receipt even when Stop raced it.
        if (current.closing && !call.post && name !== "computer_act" && name !== "computer_close") return failure("revoked", "Computer control stopped before this result could be delivered.");
        return result;
      } catch (error) {
        // A failure before any native session existed (such as an unavailable
        // helper) dispatched nothing and leaves the chat's permission as it was.
        if (lease === current && grant.revision === revision && current.nativeId && !signal.aborted) disable(grant);
        current.expectedClose ||= signal.aborted;
        const stopping = cleanup(current);
        if (!limit.signal.aborted) await stopping;
        if (call.post) return postWarning(call.post.receipt, "post_observation_failed", "human_takeover");
        const interrupted = failure(handoff ? "handoff_interrupted" : name === "computer_act" ? "dispatch_uncertain" : "operation_interrupted", `${error.message} Do not replay this call; inspect the native computer controls before continuing.`);
        return nativeResult && (name === "computer_act" || nativeResult.isError) ? withHandoff(nativeResult, interrupted) : interrupted;
      } finally {
        current.busy = false;
        signal.removeEventListener("abort", abort);
        armIdleRelease(current);
      }
    }, limit, admissionSignal);
  }
  const api = {
    async presentation(input) {
      if (!input || typeof input.visible !== "boolean" || Object.keys(input).some((key) => !["sessionId", "visible"].includes(key))) throw new Error("A chat and explicit monitor visibility are required.");
      const grant = grants.get(input.sessionId);
      const current = lease;
      if (!grant || current?.grant !== grant || !current.transport?.notifyUi) return null;
      try { assertUiActive(current); } catch { clearPresentation(current); return null; }
      if (!current.presentation) return null;
      const id = current.presentation.id;
      if (!input.visible || current.watchUntil <= now()) { delete current.presentation.frame; current.presentation.inputs = []; }
      current.watchUntil = input.visible ? now() + 1500 : 0;
      try {
        await current.transport.notifyUi({ id, action: "watch", visible: input.visible });
        assertUiActive(current);
      } catch {
        clearPresentation(current);
        if (lease === current && !current.closing) { disable(grant); void cleanup(current); }
        return null;
      }
      return current.presentation?.id === id ? structuredClone(current.presentation) : null;
    },
    async interact(input) {
      if (!input || !["approve", "deny", "takeover", "resume"].includes(input.action) || !uiText(input.id, 128) || !input.id
        || Object.keys(input).some((key) => !["sessionId", "id", "action", "windowId"].includes(key))
        || (input.action === "approve" ? !uiNumber(input.windowId, 0xffffffff) || !input.windowId : input.windowId !== undefined)) throw new Error("Choose an explicit action for this computer session. Sensitive actions still require your authorization.");
      const current = lease;
      if (!current || current.grant !== grants.get(input.sessionId) || !current.transport?.notifyUi) throw new Error("This chat does not own an active computer session.");
      assertUiActive(current);
      const presentation = current.presentation;
      if (!presentation || presentation.id !== input.id) throw new Error("This computer view is out of date. Refresh before acting.");
      if (["approve", "deny"].includes(input.action) ? presentation.phase !== "approval"
        : !current.nativeId || (input.action === "resume" ? presentation.phase !== "paused" || presentation.canContinue !== true : !["working", "paused"].includes(presentation.phase))) throw new Error("This control is not available in the current native phase.");
      if (input.action === "approve" && !presentation.windows.some((window) => window.id === input.windowId)) throw new Error("Choose a window from the current request.");
      if (input.action === "deny") {
        current.grant.personOff = true;
        disable(current.grant);
        const denied = current.transport.notifyUi({ id: input.id, action: "deny" });
        clearPresentation(current);
        try { await denied; } finally { if (!await cleanup(current)) throw new Error(COMPUTER_STOP_GUIDANCE); }
        return;
      }
      if (input.action === "takeover") {
        invalidateObservation(current);
        current.needsObservation = true;
        current.handoffGeneration++;
        if (presentation.phase === "paused") return;
        // Reducing authority must not wait on a pending resume.
        try { await current.transport.notifyUi({ id: input.id, action: "takeover" }); }
        catch (error) {
          if (lease === current && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
        return;
      }
      if (current.uiControlPending || (input.action === "approve" && current.opening?.decisionSent)) throw new Error("A control decision is already pending. Wait for its current state; do not retry it.");
      current.uiControlPending = true;
      const generation = current.handoffGeneration;
      try {
        try {
          if (input.action === "approve") { await approveWindow(current, presentation, input.windowId); return; }
          assertUiActive(current);
        } catch (error) {
          if (lease === current && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
        const live = current.presentation;
        if (live?.id !== input.id || live.phase !== "paused" || live.canContinue !== true || current.handoffGeneration !== generation) {
          throw new Error("The native controls changed before Continue. Review their current state; no control was resumed.");
        }
        invalidateObservation(current);
        current.needsObservation = true;
        current.handoffGeneration++;
        try { await current.transport.notifyUi({ id: input.id, action: "resume" }); }
        catch (error) {
          if (lease === current && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
      } finally { current.uiControlPending = false; }
    },
    /** @param {ChatInput} input */
    async snapshot({ sessionId } = {}) { return view(await grantFor(sessionId), true); },
    /** @param {ChatInput & { expectedRevision?: number, enabled?: boolean }} input */
    async configure({ sessionId, expectedRevision, enabled } = {}) {
      if (typeof enabled !== "boolean") throw new Error("Choose an explicit computer use setting.");
      const grant = await grantFor(sessionId);
      const revision = revise(grant, expectedRevision);
      grant.enabled = false;
      grant.personOff = !enabled;
      if (lease?.grant === grant) await cleanup(lease);
      if (grant.revision !== revision || closed || resetting) throw new Error("The computer use setting was interrupted before it finished.");
      if (lease?.grant === grant) return view(grant);
      if (enabled) {
        const ready = await readiness();
        if (grant.revision !== revision || closed || resetting) throw new Error("The computer use setting was interrupted before it finished.");
        grant.enabled = ready.readiness === "ready";
      }
      return view(grant);
    },
    /** @param {ChatInput & { expectedRevision?: number }} input */
    async stop({ sessionId, expectedRevision } = {}) {
      // An already validated grant can always be revoked.
      const grant = grants.get(sessionId) ?? await grantFor(sessionId);
      revise(grant, expectedRevision);
      grant.enabled = false;
      grant.personOff = true;
      if (lease?.grant === grant && !await cleanup(lease)) throw new Error(COMPUTER_STOP_GUIDANCE);
      return view(grant);
    },
    /** @param {ChatInput & { allowed?: boolean }} input */
    async alwaysAllow({ sessionId, allowed } = {}) {
      if (typeof allowed !== "boolean") throw new Error("Choose an explicit Always allow setting.");
      const grant = await grantFor(sessionId);
      if (!allowed) {
        // Turning it off returns every chat to asking first.
        await standing.set(false);
        if (!await api.revoke()) throw new Error(COMPUTER_STOP_GUIDANCE);
        return view(grant);
      }
      await standing.set(true);
      for (const other of grants.values()) other.personOff = false;
      if (!grant.enabled && !(lease && lease.grant !== grant) && (await readiness()).readiness === "ready") grant.enabled = true;
      await rearm();
      return view(grant);
    },
    /** @param {{ permission?: "accessibility" | "screenRecording" }} input */
    async setup({ permission } = {}) {
      if (closed || resetting || lease) throw new Error("Stop computer use before opening permission setup.");
      if (!["accessibility", "screenRecording"].includes(permission)) throw new Error("Choose Accessibility or Screen Recording settings.");
      return adapter.setup(permission);
    },
    /** @param {{ setupId?: string }} input */
    async dismissSetup({ setupId } = {}) {
      if (typeof adapter.dismissSetup === "function") await adapter.dismissSetup(typeof setupId === "string" ? setupId : undefined);
    },
    /**
     * Tool calls from the engine, scoped to the requesting chat by the bridge.
     * @param {ChatInput & { name?: string, args?: Record<string, unknown> }} input
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<ComputerResult>}
     */
    async execute({ sessionId, name, args } = {}, { signal = new AbortController().signal } = {}) {
      const limit = deadline(operationMs);
      try {
        if (!Object.hasOwn(COMPUTER_TOOLS, name)) return failure("unknown_tool", "This computer tool does not exist.");
        if (typeof sessionId !== "string" || !sessionId.trim()) return failure("missing_session", "Computer use requires a requesting chat.");
        if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some((key) => !(ARGUMENTS[name] ?? []).includes(key))) {
          return failure("invalid_arguments", "Only native computer arguments are accepted; session and receipt identities belong to OpenWork.");
        }
        if (name === "computer_act" && (args.action === undefined) === (args.actions === undefined)) return failure("invalid_arguments", "Provide exactly one of action or actions.");
        if (closed || resetting) return failure("stopping", "Computer use is stopping or restarting. Nothing was dispatched.");
        const always = await standingAllowed();
        const grant = await grantFor(sessionId);
        if (!grant.enabled) {
          return failure("not_allowed", always && !grant.personOff
            ? "Computer use stopped earlier in this turn, because the person stopped it or after a failure. It turns back on with the person's next message, so do not ask them to re-enable it; tell them what failed."
            : "Computer use is off for this chat. Ask the person to allow it with the Computer button in the chat header, then try again. Nothing was dispatched.");
        }
        const status = name === "computer_discover" || name === "computer_open" ? await readiness() : null;
        if (status && status.readiness !== "ready") return failure("setup_required", `${status.detail} Ask the person to finish setup from the Computer button in the chat header.`);
        const call = { name, args: structuredClone(args), grant, revision: grant.revision };
        return deliverResult(call, await run(call, signal, limit));
      } catch (error) {
        return failure("computer_error", `${error instanceof Error ? error.message : String(error)} Do not replay this call; inspect the computer controls before continuing.`);
      } finally { limit.dispose(); }
    },
    /**
     * The chat's turn ended: release its native session and re-arm Always allow.
     * @param {ChatInput} input
     */
    async endTurn({ sessionId } = {}) {
      if (typeof sessionId !== "string" || !sessionId) return true;
      if (lease?.grant.sessionId === sessionId) return release(lease);
      await rearm(sessionId);
      return true;
    },
    /** @param {ChatInput} input */
    async revoke({ sessionId } = {}) {
      for (const grant of grants.values()) if (!sessionId || grant.sessionId === sessionId) disable(grant);
      if (lease && (!sessionId || lease.grant.sessionId === sessionId)) return cleanup(lease);
      return true;
    },
    async reset(shutdown = false) {
      resetting++;
      if (shutdown) closed = true;
      try { return await api.revoke(); }
      finally { resetting--; }
    },
  };
  return api;
}
