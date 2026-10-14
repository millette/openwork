import { useState } from "react"
import { Monitor } from "lucide-react"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"
import { useComputerStore } from "./computer-store"

/** "com.apple.TextEdit" reads as "TextEdit"; the agent's own purpose says the rest. */
function appLabel(appId: string | undefined) {
  const name = appId?.split(".").filter(Boolean).at(-1)
  return name && name.length <= 48 ? name : "a Mac app"
}

/**
 * Shown above the composer while the agent waits for computer use. The tool
 * call carries on by itself once the person answers, so the agent never has
 * to ask them to go set it up and try again.
 */
export function ComputerRequestPanel({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  const openSetup = useComputerStore((state) => state.openSetup)
  const [busy, setBusy] = useState<"allow" | "always" | "dismiss" | null>(null)
  const [error, setError] = useState("")
  const setup = request.reason === "setup"
  const remote = request.placement === "remote"
  const where = remote ? ` on ${request.computer}` : ""

  async function answer(next: "allow" | "always" | "dismiss") {
    if (busy) return
    setBusy(next)
    setError("")
    try {
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason={request.reason}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-dls-text">The agent wants to use {request.appId === "desktop" ? "the desktop" : appLabel(request.appId)}{where}</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">
              {setup && remote
                ? `${request.computer} isn't ready yet. ${request.detail ?? ""} The agent carries on once it is.`
                : setup
                  ? "Computer use needs two macOS permissions first. It takes about a minute, and the agent carries on when you're done."
                  : remote
                    ? `Allow computer use on ${request.computer} in this chat? You can watch it, take over or stop anytime.`
                    : "Allow computer use in this chat? You'll see the agent's cursor on screen and can take over or stop anytime."}
            </div>
            {request.purpose ? <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-dls-secondary">{request.purpose}</div> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-request-dismiss" onClick={() => void answer("dismiss")}>
            Not now
          </Button>
          {setup && remote ? null : setup ? (
            <Button type="button" size="sm" data-testid="session-computer-request-setup" onClick={() => openSetup(sessionId)}>
              Set up
            </Button>
          ) : <>
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-request-always" onClick={() => void answer("always")}>
              Always allow
            </Button>
            <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-request-allow" onClick={() => void answer("allow")}>
              Allow for this chat
            </Button>
          </>}
        </div>
      </div>
    </div>
  )
}
