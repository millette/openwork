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
import { useComputerRequest, useComputerStore } from "./computer-store"

export type ComputerBusy = "allow" | "always" | "stop" | "halt" | "reset" | ComputerPermission | null

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
 * The chat header's Computer button: this chat's allowance, Always allow, the
 * setup checklist and Stop & revoke. Mounted only for a real chat on the macOS
 * desktop app with the `computerUse` feature on. Navigating away never revokes.
 */
export function ComputerControl({ sessionId }: { sessionId: string }) {
  const floatingSlot = useSessionFloatingSlot()
  const request = useComputerRequest(sessionId)
  const setupOpen = useComputerStore((state) => state.setupSessionId === sessionId)
  const openSetup = useComputerStore((state) => state.openSetup)
  const closeSetup = useComputerStore((state) => state.closeSetup)
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null)
  const [readError, setReadError] = useState("")
  const [actionError, setActionError] = useState("")
  const [busy, setBusy] = useState<ComputerBusy>(null)
  const [visible, setVisible] = useState(document.visibilityState === "visible")
  const requestVersion = useRef(0)
  const reading = useRef<number | null>(null)
  const changing = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)

  async function refresh() {
    if (changing.current || reading.current === requestVersion.current) return
    const version = ++requestVersion.current
    reading.current = version
    try {
      const next = await desktopBridge.computerSnapshot(sessionId)
      if (version !== requestVersion.current) return
      setSnapshot(next)
      setReadError("")
    } catch (cause) {
      if (version === requestVersion.current) setReadError(message(cause))
    } finally {
      if (reading.current === version) reading.current = null
    }
  }

  const readLatest = useEffectEvent(refresh)
  useEffect(() => {
    void readLatest()
    const onVisibility = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      // Discard late observations, never revoke on navigation.
      requestVersion.current += 1
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const working = Boolean(snapshot?.session || snapshot?.cleanupPending)
  // Poll quickly while setup or a request waits on macOS; otherwise only while something runs.
  const observing = visible && (open || setupOpen || Boolean(request) || working)
  useEffect(() => {
    if (!observing) return
    void readLatest()
    const timer = window.setInterval(() => void readLatest(), setupOpen || request ? 1_500 : 2_000)
    const onFocus = () => void readLatest()
    window.addEventListener("focus", onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus) }
  }, [observing, open, setupOpen, request])

  async function act(action: Exclude<ComputerBusy, null | "reset">) {
    if (changing.current || !snapshot) return
    const permission = action === "accessibility" || action === "screenRecording" ? action : null
    if (permission && (readError || !snapshot.permissions)) return
    changing.current = true
    // A read started before this explicit action must not overwrite its result.
    const version = ++requestVersion.current
    setBusy(action)
    setActionError("")
    let failed = false
    try {
      let next: ComputerSnapshot
      if (permission) {
        await desktopBridge.computerSetup(permission)
        if (version !== requestVersion.current) return
        next = await desktopBridge.computerSnapshot(sessionId)
      } else if (action === "always") {
        next = await desktopBridge.computerAlwaysAllow({ sessionId, allowed: !snapshot.alwaysAllowed })
      } else if (action === "allow") {
        next = await desktopBridge.computerConfigure({ sessionId, expectedRevision: snapshot.revision, enabled: true })
      } else if (action === "halt") {
        next = await desktopBridge.computerHalt(sessionId)
      } else {
        next = await desktopBridge.computerStop({ sessionId, expectedRevision: snapshot.revision })
      }
      if (version !== requestVersion.current) return
      setSnapshot(next)
      setReadError("")
    } catch (cause) {
      if (version !== requestVersion.current) return
      failed = true
      const label = action === "allow" ? "Allowing computer use" : action === "always" ? "Always allow" : action === "stop" ? "Stop & revoke" : action === "halt" ? "Stop" : "Setup"
      setActionError(`${label} wasn't confirmed. ${message(cause)} Check the latest state before trying again.`)
    } finally {
      if (version === requestVersion.current) {
        changing.current = false
        setBusy(null)
      }
    }
    // Includes stale-revision errors: reread, but never silently repeat a write.
    if (failed && version === requestVersion.current) void refresh()
  }

  async function reset(permission: ComputerPermission) {
    if (changing.current) return
    changing.current = true
    setBusy("reset")
    setActionError("")
    try {
      await desktopBridge.computerResetPermission(permission)
    } catch (cause) {
      setActionError(`Reset didn't finish. ${message(cause)}`)
    } finally {
      changing.current = false
      setBusy(null)
      void refresh()
    }
  }

  const session = snapshot?.session ?? null
  const allowed = Boolean(snapshot?.allowed)
  const ready = snapshot?.readiness === "ready"
  const status = snapshot
    ? snapshot.cleanupPending ? "Stopping" : allowed ? snapshot.alwaysAllowed ? "Always allowed" : "Allowed for this chat" : "Off for this chat"
    : readError ? "Unavailable" : "Checking..."
  const readiness = snapshot ? { ready: "Ready", "setup-required": "Setup needed", unsupported: "Unsupported", unavailable: "Unavailable" }[snapshot.readiness] : ""
  const needsAttention = Boolean(request || readError || actionError || snapshot?.cleanupPending || session?.state === "unavailable")
  const phase = snapshot?.cleanupPending ? "Stopping"
    : session?.state === "unavailable" ? "Status unavailable"
    : session?.state === "paused" || session?.phase === "person_interacting" || session?.phase === "ready_to_continue" ? "You have control"
    : session?.state === "opening" ? "Choosing an app window"
    : session?.phase ? phaseLabel(session.phase)
    : "Access allowed"
  const expires = session?.expiresAt ? new Date(session.expiresAt) : null

  return (
    <>
      {floatingSlot && snapshot && working ? (
        <ComputerPanel
          key={sessionId}
          sessionId={sessionId}
          slot={floatingSlot}
          enabled={snapshot.enabled}
          canStop
          controlsBusy={busy !== null}
          stopping={busy === "halt"}
          cleanupPending={Boolean(snapshot.cleanupPending)}
          stopError={actionError}
          onStop={() => void act("halt")}
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
                    data-state={needsAttention ? "attention" : allowed ? "allowed" : "off"}
                    aria-label={`Computer use: ${request ? "the agent is waiting for you" : needsAttention ? "check status" : snapshot ? status : "open settings"}`}
                    className={cn(
                      "relative rounded-xl text-gray-10 hover:bg-muted hover:text-foreground",
                      (open || setupOpen) && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                    )}
                  >
                    <Monitor size={16} />
                    {needsAttention
                      ? <AlertTriangle aria-hidden className="absolute right-0.5 top-0.5 size-3 text-amber-11" />
                      : allowed ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-green-9" /> : null}
                  </Button>
                }
              />
            }
          />
          <TooltipContent>{`Computer · ${request ? "Waiting for you" : needsAttention ? "Check status" : [status, session ? phase : readiness].filter(Boolean).join(" · ")}`}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-[min(360px,calc(100vw-32px))] gap-3 text-xs leading-relaxed text-muted-foreground" data-testid="session-computer-popover">
          <h2 className="text-sm font-semibold text-foreground">Computer use</h2>
          <p>Let the agent use Mac apps for tasks you ask for in this chat. It sees only the window it is given, and that content goes to your AI model provider.</p>
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/30 p-3">
            <span aria-hidden className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", needsAttention ? "bg-amber-9" : allowed ? "bg-green-9" : "bg-gray-7")} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-foreground" role="status" data-testid="session-computer-status">{readError && snapshot ? `Last known: ${status}` : status}</p>
              {snapshot ? <p data-testid="session-computer-readiness" data-state={snapshot.readiness}>{["This Mac", readiness].join(" · ")}</p> : null}
            </div>
          </div>
          {readError ? <p role="alert" className="text-red-11" data-testid="session-computer-read-error">{snapshot ? "Updates unavailable. Last known state is shown; a connection failure does not confirm a stop. " : "Computer use is unavailable. "}{readError}</p> : null}
          {actionError ? <p role="alert" className="text-red-11" data-testid="session-computer-action-error">{actionError}</p> : null}
          {snapshot && !ready ? <p>{snapshot.readiness === "setup-required" ? `macOS needs two permissions for ${snapshot.entry.name} first.` : snapshot.detail}</p> : null}
          {snapshot?.busyElsewhere && !working ? <p className="text-amber-11">Another chat is using this Mac right now. This chat can use it once that one finishes or is stopped.</p> : null}
          {snapshot ? (
            <label className="flex items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">Always allow</span>
                <span className="block">Every chat can use this Mac without asking. You'll see the agent's cursor on screen and can take over anytime.</span>
              </span>
              <Switch
                className="mt-0.5"
                checked={snapshot.alwaysAllowed}
                aria-label="Always allow computer use"
                aria-busy={busy === "always"}
                disabled={Boolean(readError) || busy !== null}
                data-testid="session-computer-always-allow"
                onCheckedChange={() => void act("always")}
              />
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {snapshot && !allowed ? <Button size="sm" disabled={busy !== null || Boolean(readError)} aria-busy={busy === "allow"} data-testid="session-computer-allow" onClick={() => void act("allow")}>Allow for this chat</Button> : null}
            {snapshot && (allowed || working) ? <Button size="sm" variant="destructive" disabled={busy !== null} aria-busy={busy === "stop"} data-testid="session-computer-stop" onClick={() => void act("stop")}>Stop &amp; revoke</Button> : null}
            <Button
              size="sm"
              variant={snapshot?.readiness === "setup-required" ? "default" : "outline"}
              disabled={busy !== null || !snapshot || snapshot.readiness === "unsupported"}
              data-testid="session-computer-setup"
              onClick={() => { setOpen(false); openSetup(sessionId) }}
            >
              {snapshot?.readiness === "setup-required" ? "Set up" : "Permissions"}
            </Button>
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
            </section>
          ) : null}
          <details className="space-y-2">
            <summary className="cursor-pointer text-foreground">Access and privacy</summary>
            <p>Only the approved app window is captured, not your whole desktop. A window you approve once in this chat opens again without asking. Your own input pauses the agent; Continue hands control back.</p>
            <p>Stop in the Computer view ends the current task and keeps this chat allowed. Stop &amp; revoke turns the chat off. Allowing doesn't approve purchases, sending messages or deleting files.</p>
          </details>
        </PopoverContent>
      </Popover>
      {setupOpen ? (
        <ComputerSetup
          snapshot={snapshot}
          readError={readError}
          actionError={actionError}
          busy={busy}
          onPermission={(permission) => void act(permission)}
          onReset={(permission) => void reset(permission)}
          onRefresh={() => void refresh()}
          onAllow={() => void act("allow")}
          onAlways={() => void act("always")}
          onClose={() => { closeSetup(); void desktopBridge.computerDismissSetup().catch(() => {}); trigger.current?.focus() }}
        />
      ) : null}
    </>
  )
}
