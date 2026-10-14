import { useEffect, useRef } from "react"

import { desktopBridge } from "@/app/lib/desktop"
import { isActiveWorkSessionStatus } from "../sidebar/utils"

/**
 * When a chat stops working, its turn is over: the desktop releases that
 * chat's native computer session (the agent's cursor and pill go away) and
 * re-arms Always allow. The broker also releases idle sessions on its own;
 * this only makes the hand-back immediate.
 */
export function useComputerTurnEnds(statusById: Record<string, string>, enabled: boolean) {
  const previous = useRef<Record<string, string>>({})
  useEffect(() => {
    const before = previous.current
    previous.current = statusById
    if (!enabled) return
    for (const [sessionId, status] of Object.entries(before)) {
      if (isActiveWorkSessionStatus(status) && !isActiveWorkSessionStatus(statusById[sessionId])) {
        void desktopBridge.computerEndTurn(sessionId).catch(() => {})
      }
    }
  }, [statusById, enabled])
}
