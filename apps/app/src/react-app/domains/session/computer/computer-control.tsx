import { useEffect, useEffectEvent, useRef, useState } from "react"
import { AlertTriangle, Monitor } from "lucide-react"
import type { ComputerPermission, ComputerSnapshot } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useSessionFloatingSlot } from "../panel/floating-slot"
import { ComputerPanel } from "./computer-panel"
import { ComputerSetup } from "./computer-setup"

export type ComputerBusy = "allow" | "always" | "stop" | ComputerPermission | null

const NATIVE_PHASE_LABELS: Record<string, string> = {
  person_interacting: "You have control",
  ready_to_continue: "Ready to continue",
  refreshing: "Connecting to the app window",
  working: "Working",
  "native-approval": "Choosing an app window",
}

const phaseLabel = (phase: string) => NATIVE_PHASE_LABELS[phase] ?? phase.replaceAll("_", " ").replaceAll("-", " ")
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/**
 * The chat header's Computer button: per-chat consent, Always allow, setup and
 * Stop & revoke. Mounted only for a real chat on the macOS desktop app with the
 * `computerUse` feature on. Navigating away never revokes access.
 */
export function ComputerControl({ sessionId }: { sessionId: string }) {
  const floatingSlot = useSessionFloatingSlot()
  const [open, setOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null)
  const [readError, setReadError] = useState("")
  const [actionError, setActionError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<ComputerBusy>(null)
  const [visible, setVisible] = useState(document.visibilityState === "visible")
  const request = useRef(0)
  const reading = useRef<number | null>(null)
  const changing = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)

  async function refresh() {
    if (changing.current || reading.current === request.current) return
    const version = ++request.current
    reading.current = version
    setRefreshing(true)
    try {
      const next = await desktopBridge.computerSnapshot(sessionId)
      if (version !== request.current) return
      setSnapshot(next)
      setReadError("")
    } catch (cause) {
      if (version === request.current) setReadError(message(cause))
    } finally {
      if (reading.current === version) reading.current = null
      if (version === request.current) setRefreshing(false)
    }
  }

  const readLatest = useEffectEvent(refresh)
  useEffect(() => {
    void readLatest()
    const onVisibility = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      // Discard late observations, never revoke a native grant on navigation.
      request.current += 1
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const canStop = Boolean(snapshot && (snapshot.enabled || snapshot.session || snapshot.cleanupPending))
  const observing = ((open || setupOpen) && visible) || canStop
  useEffect(() => {
    if (!observing) return
    void readLatest()
    const timer = window.setInterval(() => void readLatest(), 2_000)
    const onFocus = () => void readLatest()
    window.addEventListener("focus", onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus) }
  }, [observing, open, setupOpen, visible])

  const ready = snapshot?.readiness === "ready"
  const canAllow = snapshot !== null && !canStop && !readError && ready
  const canAlwaysAllow = snapshot !== null && !readError && (snapshot.alwaysAllowed || ready)

  async function act(action: Exclude<ComputerBusy, null>) {
    if (changing.current || !snapshot) return
    if (action === "allow" && !canAllow) return
    if (action === "stop" && !canStop) return
    if (action === "always" && !canAlwaysAllow) return
    const permission = action === "accessibility" || action === "screenRecording" ? action : null
    if (permission && (canStop || readError || !snapshot.permissions)) return
    changing.current = true
    // A read started before this explicit action must not overwrite its result.
    const version = ++request.current
    setBusy(action)
    setRefreshing(false)
    setActionError("")
    let failed = false
    try {
      let next: ComputerSnapshot
      if (permission) {
        await desktopBridge.computerSetup(permission)
        if (version !== request.current) return
        next = await desktopBridge.computerSnapshot(sessionId)
      } else if (action === "always") {
        next = await desktopBridge.computerAlwaysAllow({ sessionId, allowed: !snapshot.alwaysAllowed })
      } else if (action === "allow") {
        next = await desktopBridge.computerConfigure({ sessionId, expectedRevision: snapshot.revision, enabled: true })
      } else {
        next = await desktopBridge.computerStop({ sessionId, expectedRevision: snapshot.revision })
      }
      if (version !== request.current) return
      setSnapshot(next)
      setReadError("")
    } catch (cause) {
      if (version !== request.current) return
      failed = true
      const label = action === "allow" ? "Allowing computer use" : action === "always" ? "Always allow" : action === "stop" ? "Stop & revoke" : "Setup"
      setActionError(`${label} was not confirmed. ${message(cause)} Check the latest state before trying again.`)
    } finally {
      if (version === request.current) {
        changing.current = false
        setBusy(null)
      }
    }
    // Includes stale-revision errors: reread, but never silently repeat a write.
    if (failed && version === request.current) void refresh()
  }

  const session = snapshot?.session ?? null
  const status = snapshot
    ? snapshot.cleanupPending ? "Stopping" : snapshot.enabled ? snapshot.alwaysAllowed ? "Always allowed" : "Allowed for this chat" : "Off for this chat"
    : readError ? "Unavailable" : "Checking..."
  const readiness = snapshot ? { ready: "Ready", "setup-required": "Setup required", unsupported: "Unsupported", unavailable: "Unavailable" }[snapshot.readiness] : ""
  const needsAttention = Boolean(readError || actionError || snapshot?.cleanupPending || session?.state === "unavailable")
  const phase = snapshot?.cleanupPending ? "Stopping"
    : session?.state === "unavailable" ? "Status unavailable"
    : session?.state === "paused" || session?.phase === "person_interacting" || session?.phase === "ready_to_continue" ? "You have control"
    : session?.state === "opening" ? "Choosing an app window"
    : session?.phase ? phaseLabel(session.phase)
    : "Access allowed"
  const expires = session?.expiresAt ? new Date(session.expiresAt) : null

  return (
    <>
      {floatingSlot && snapshot && canStop ? (
        <ComputerPanel
          key={sessionId}
          sessionId={sessionId}
          slot={floatingSlot}
          enabled={snapshot.enabled}
          canStop={canStop}
          controlsBusy={busy !== null}
          stopping={busy === "stop"}
          cleanupPending={Boolean(snapshot.cleanupPending)}
          stopError={actionError}
          onStop={() => void act("stop")}
        />
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    ref={trigger}
                    variant="ghost"
                    size="icon-sm"
                    data-testid="session-computer-control"
                    data-state={needsAttention ? "attention" : snapshot?.enabled ? "allowed" : "off"}
                    aria-label={`Computer use: ${needsAttention ? "check status" : snapshot ? status : "open settings"}`}
                    className={cn(
                      "relative rounded-xl text-gray-10 hover:bg-muted hover:text-foreground",
                      (open || setupOpen) && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                    )}
                  >
                    <Monitor size={16} />
                    {needsAttention
                      ? <AlertTriangle aria-hidden className="absolute right-0.5 top-0.5 size-3 text-amber-11" />
                      : snapshot?.enabled ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-green-9" /> : null}
                  </Button>
                }
              />
            }
          />
          <TooltipContent>{`Computer · ${needsAttention ? "Check status" : [status, session ? phase : readiness].filter(Boolean).join(" · ")}`}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-[min(360px,calc(100vw-32px))] gap-3 text-xs leading-relaxed text-muted-foreground" data-testid="session-computer-popover">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Computer use</h2>
          </div>
          <p>Let the agent use Mac apps for tasks you ask for in this chat. It sees only the window it is given, and that content goes to your AI model provider.</p>
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/30 p-3">
            <span aria-hidden className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", needsAttention ? "bg-amber-9" : snapshot?.enabled ? "bg-green-9" : "bg-gray-7")} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-foreground" role="status" data-testid="session-computer-status">{readError && snapshot ? `Last known: ${status}` : status}</p>
              {snapshot ? <p data-testid="session-computer-readiness" data-state={snapshot.readiness}>{["This Mac", readiness].join(" · ")}</p> : null}
            </div>
          </div>
          {readError ? <p role="alert" className="text-red-11" data-testid="session-computer-read-error">{snapshot ? "Updates unavailable. Last known state is shown; a connection failure does not confirm a stop. " : "Computer use is unavailable. "}{readError}</p> : null}
          {actionError ? <p role="alert" className="text-red-11" data-testid="session-computer-action-error">{actionError}</p> : null}
          {snapshot?.detail && (snapshot.readiness !== "ready" || snapshot.cleanupPending) ? <p>{snapshot.detail}</p> : null}
          {snapshot?.busyElsewhere && !canStop ? <p className="text-amber-11">Another chat is using this Mac right now. This chat can use it once that one finishes or is stopped.</p> : null}
          {snapshot ? (
            <label className="flex items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">Always allow</span>
                <span className="block">Every chat can use this Mac without asking again. You will see the agent's cursor on screen and can take over anytime.</span>
              </span>
              <Switch
                className="mt-0.5"
                checked={snapshot.alwaysAllowed}
                aria-label="Always allow computer use"
                aria-busy={busy === "always"}
                disabled={!canAlwaysAllow || busy !== null}
                data-testid="session-computer-always-allow"
                onCheckedChange={() => void act("always")}
              />
            </label>
          ) : null}
          {!canStop ? <p>{ready ? "Or allow just this chat. Then ask for a task; the agent opens the app window it needs." : "Set up macOS permissions first, then allow computer use."}</p> : null}
          <div className="flex flex-wrap gap-2">
            {!canStop && ready ? <Button size="sm" disabled={!canAllow || busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-allow" onClick={() => void act("allow")}>Allow for this chat</Button> : null}
            {canStop ? <Button size="sm" variant="destructive" disabled={busy !== null} aria-busy={busy === "stop"} data-testid="session-computer-stop" onClick={() => void act("stop")}>Stop &amp; revoke</Button> : null}
            <Button
              size="sm"
              variant={!canStop && snapshot?.readiness === "setup-required" ? "default" : "outline"}
              disabled={busy !== null || !snapshot || snapshot.readiness === "unsupported"}
              data-testid="session-computer-setup"
              onClick={() => { setOpen(false); setSetupOpen(true) }}
            >
              {snapshot?.readiness === "setup-required" ? "Set up permissions" : "Permissions"}
            </Button>
            <Button size="sm" variant="ghost" disabled={refreshing || busy !== null} aria-busy={refreshing} data-testid="session-computer-refresh" onClick={() => void refresh()}>Check status</Button>
          </div>
          {session ? (
            <section className="space-y-2 rounded-2xl border border-border bg-muted/30 p-3" aria-label="Computer session" data-testid="session-computer-session">
              <h3 className="font-semibold text-foreground">Current app</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>State</dt><dd className="text-foreground" data-testid="session-computer-phase">{phase}</dd>
                <dt>Purpose</dt><dd>{session.purpose}</dd>
                {session.appName ? <><dt>App</dt><dd>{session.appName}</dd></> : null}
                {session.windowTitle ? <><dt>Window</dt><dd>{session.windowTitle}</dd></> : null}
                {expires ? <><dt>Expires</dt><dd>{Number.isNaN(expires.getTime()) ? "Unavailable" : expires.toLocaleTimeString(undefined, { timeStyle: "short" })}</dd></> : null}
              </dl>
              {session.reason ? <p>{session.reason}</p> : null}
              <p>Session state describes computer access, not task completion.</p>
            </section>
          ) : null}
          <details className="space-y-2">
            <summary className="cursor-pointer text-foreground">Access &amp; privacy</summary>
            <p>Only the selected app window is captured, not your whole desktop. Its content can be sent to your selected model provider. The floating view shows recent frames; its pointer marks actual computer input, not task completion or your Mac cursor.</p>
            <p>Your own input pauses control. Take over and Continue are explicit controls in the Computer view and on the agent's pill over the app window. Allowing access does not approve purchases, sending messages, deleting files, or other sensitive actions.</p>
            <p>Stop &amp; revoke ends this chat's access. Minimizing the view or switching chats stops preview capture, not work or access. macOS permissions remain separate. Use the browser for websites.</p>
          </details>
        </PopoverContent>
      </Popover>
      {setupOpen ? (
        <ComputerSetup
          snapshot={snapshot}
          readError={readError}
          actionError={actionError}
          refreshing={refreshing}
          busy={busy}
          canAllow={canAllow}
          canStop={canStop}
          onPermission={(permission) => void act(permission)}
          onRefresh={() => void refresh()}
          onAllow={() => void act("allow")}
          onStop={() => void act("stop")}
          onClose={() => { setSetupOpen(false); void desktopBridge.computerDismissSetup().catch(() => {}); trigger.current?.focus() }}
        />
      ) : null}
    </>
  )
}
