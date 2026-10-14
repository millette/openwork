import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"

import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { setComputerTasksFollowedInChat } from "../surface/composer/computer-mentions"
import { useRemoteThreadStore } from "./remote-thread-store"

const FEATURE_STALE_MS = 5 * 60_000

/**
 * Reads `remoteSessionSubagents` for the active organization. Tasks on other
 * computers need a signed-in organization, so signed out, unreachable or
 * missing means off: the chat shows the plain tool call as before and nothing
 * is followed.
 */
export function useRemoteSessionSubagentsFeature(): void {
  const context = useAutomationsDenContext()
  const organization = useQuery({
    // Shares the cache with the other organization feature reads.
    queryKey: ["den", "org-features", context.organizationId],
    queryFn: (): Promise<Record<string, boolean>> => context.client && context.organizationId
      ? context.client.getOrgFeatures(context.organizationId)
      : Promise.resolve({}),
    enabled: context.ready,
    staleTime: FEATURE_STALE_MS,
    select: (features) => features.remoteSessionSubagents === true,
  })
  const enabled = context.ready && organization.data === true
  useEffect(() => {
    useRemoteThreadStore.getState().setEnabled(enabled)
    setComputerTasksFollowedInChat(enabled)
  }, [enabled])
}
