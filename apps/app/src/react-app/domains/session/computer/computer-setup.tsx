import type { ComputerPermission, ComputerSnapshot } from "@openwork/types/desktop-ipc"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { ComputerBusy } from "./computer-control"

const permissions: Array<{ id: ComputerPermission; title: string; purpose: string; path: string }> = [
  { id: "accessibility", title: "Accessibility", purpose: "Read app controls and use the mouse and keyboard in an approved session.", path: "Privacy & Security > Accessibility" },
  { id: "screenRecording", title: "Screen Recording", purpose: "See the selected app window. Its content can be sent to the AI model provider handling your request.", path: "Privacy & Security > Screen Recording (or Screen & System Audio Recording)" },
]

/** Guidance never grants access. Every status comes from the native helper probe. */
export function ComputerSetup({ snapshot, readError, actionError, refreshing, busy, canAllow, canStop, onPermission, onRefresh, onAllow, onStop, onClose }: {
  snapshot: ComputerSnapshot | null
  readError: string
  actionError: string
  refreshing: boolean
  busy: ComputerBusy
  canAllow: boolean
  canStop: boolean
  onPermission: (permission: ComputerPermission) => void
  onRefresh: () => void
  onAllow: () => void
  onStop: () => void
  onClose: () => void
}) {
  const verified = readError ? undefined : snapshot?.permissions
  const ready = snapshot?.readiness === "ready" && verified?.accessibility === true && verified.screenRecording === true
  const allowed = Boolean(snapshot?.enabled && !snapshot.cleanupPending && !readError)
  const nextPermission = permissions.find((permission) => verified?.[permission.id] === false)?.id
  const status = readError ? "Could not verify permissions"
    : !snapshot ? "Checking this Mac..."
    : snapshot.readiness === "unsupported" ? "Not supported on this computer"
    : snapshot.readiness === "unavailable" ? "Permission check unavailable"
    : ready ? "Both permissions verified" : "Permissions needed"

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[min(640px,calc(100dvh-32px))] gap-4 overflow-y-auto lg:max-w-xl" data-testid="session-computer-setup-dialog">
        <DialogHeader>
          <DialogTitle>Computer use on this Mac</DialogTitle>
          <DialogDescription>For Mac apps. Use the browser for websites; it does not need these macOS permissions.</DialogDescription>
        </DialogHeader>
        <ol className="space-y-4 text-xs leading-relaxed text-muted-foreground">
          <li className="flex gap-3">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-xs font-medium text-foreground">1</span>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <h3 className="font-semibold text-foreground">macOS permissions {ready ? <span className="ml-1 font-normal text-green-11">Verified</span> : null}</h3>
                <p className="mt-1">Requires macOS 14 or later. These are system-wide permissions for the helper, not approval for a task.</p>
              </div>
              <div className="space-y-2">
                {permissions.map((permission) => {
                  const granted = verified?.[permission.id]
                  return (
                    <section key={permission.id} aria-label={permission.title} className="rounded-2xl border border-border bg-muted/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-medium text-foreground">{permission.title}</h4>
                        <span data-testid={`session-computer-permission-${permission.id}`} className={cn("rounded-md px-2 py-0.5 text-[11px]", granted === true ? "bg-green-3 text-green-11" : "bg-muted text-muted-foreground")}>
                          {granted === true ? "Verified" : granted === false ? "Not granted" : "Not verified"}
                        </span>
                      </div>
                      <p className="mt-1.5">{permission.purpose}</p>
                      <Button
                        size="sm"
                        variant={nextPermission === permission.id && !canStop ? "default" : "outline"}
                        className="mt-2"
                        title={`System Settings > ${permission.path}`}
                        disabled={busy !== null || canStop || !verified}
                        aria-busy={busy === permission.id}
                        onClick={() => onPermission(permission.id)}
                      >
                        Open {permission.title} settings
                      </Button>
                    </section>
                  )
                })}
              </div>
              <details className="rounded-xl border border-border px-3 py-2">
                <summary className="cursor-pointer font-medium text-foreground">Which app do I enable?</summary>
                <p className="mt-2">Enable <strong className="font-medium text-foreground">OpenWork Computer Use</strong>, the bundled helper. macOS may show OpenWork as the responsible app. Use the entry macOS identifies for this request, not an unrelated app.</p>
                <p className="mt-2">A small guide opens next to System Settings and shows which step is left. If macOS asks you to quit and reopen, finish your work and restart OpenWork. We never change these switches for you.</p>
              </details>
              <div role="status" aria-live="polite">
                <span className={ready ? "text-foreground" : "text-amber-11"}>{status}</span>
                <span className="mt-1 block">{refreshing ? "Checking the helper now..." : "Checks refresh while this guide is open and when you return. Opening settings alone does not confirm access."}</span>
              </div>
              {readError ? <p role="alert" className="text-red-11">{readError}</p> : snapshot && ["unsupported", "unavailable"].includes(snapshot.readiness) ? <p role="alert" className="text-red-11">{snapshot.detail}</p> : null}
            </div>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs">2</span>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">Allow computer use for this chat {allowed ? <span className="ml-1 font-normal text-green-11">Allowed</span> : null}</h3>
              <p className="mt-1">Allowing lets the agent see and use supported apps for tasks you request here. App window content can be sent to your selected AI model provider. Off by default; allowing alone does not start work. Other chats ask again unless you turn on Always allow.</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs">3</span>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">Watch in the Computer view</h3>
              <p className="mt-1">When you ask for an app task, a single eligible window opens automatically in the floating Computer view. If several windows are available, choose one there. Watch, take over, go full screen or stop without leaving the chat. The agent's cursor and a pill over the app window show what it is doing.</p>
              <p className="mt-1">Computer use is not an OS sandbox or approval for purchases, sending messages, deleting files, or other sensitive actions. Those need separate authorization.</p>
            </div>
          </li>
        </ol>
        {allowed ? <p role="status" className="rounded-xl border border-green-6/30 bg-green-2/30 px-3 py-2 text-xs text-foreground" data-testid="session-computer-setup-ready">Computer use is allowed for this chat. Nothing has started; return to the chat to ask for a task.</p> : null}
        {canStop ? <p className="text-xs text-amber-11">{snapshot?.cleanupPending ? "Stopping is still being confirmed. Use Stop & revoke to check release again." : "Access is already allowed or a session still exists. Stop & revoke before changing macOS permissions here."}</p> : null}
        {actionError ? <p role="alert" className="text-xs text-red-11">{actionError}</p> : null}
        <DialogFooter>
          <Button variant="ghost" disabled={refreshing || busy !== null} aria-busy={refreshing} onClick={onRefresh}>Check permissions</Button>
          {canStop ? <Button variant="destructive" disabled={busy !== null} aria-busy={busy === "stop"} onClick={onStop}>Stop &amp; revoke</Button> : null}
          {ready && !canStop ? <Button disabled={!canAllow || refreshing || busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-setup-allow" onClick={onAllow}>Allow for this chat</Button> : null}
          {allowed ? <Button onClick={onClose}>Back to chat</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
