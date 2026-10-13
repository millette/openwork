import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { notificationCenter } from "../worlds/notification-center.ts";

// Keep the existing Electron background-event regression; member-activity-sync uses
// appWeb for the new member inventory story without a native dependency.
const test = spec.world(notificationCenter, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Preserves the existing desktop background-event integration regression." },
});

const bell: Target = { role: "button", label: /^Activity/ };
const emptyTitle: Target = { text: "Nothing new" };

type ListedNotification = { kind: string; title: string; readAt: number | null; count: number; actionType: string | null };

function listed(value: unknown): ListedNotification[] {
  if (!Array.isArray(value)) throw new Error(`notifications.list did not return a list: ${JSON.stringify(value)}`);
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Malformed notification entry");
    const kind: unknown = Reflect.get(entry, "kind");
    const title: unknown = Reflect.get(entry, "title");
    const readAt: unknown = Reflect.get(entry, "readAt");
    const count: unknown = Reflect.get(entry, "count");
    const actionType: unknown = Reflect.get(entry, "actionType");
    if (typeof kind !== "string" || typeof title !== "string" || typeof count !== "number"
      || (readAt !== null && typeof readAt !== "number") || (actionType !== null && typeof actionType !== "string")) {
      throw new Error(`Malformed notification entry: ${JSON.stringify(entry)}`);
    }
    return { kind, title, readAt, count, actionType };
  });
}

test("Activity holds only member changes; device notices stay out of it", async ({ world, user, agent, probe, step, evidence }) => {
  const center = async () => listed(await agent.run("notifications.list"));
  const closeCenter = async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom("[data-notification-panel]"), {
      within: 10_000, label: "Activity popover closes", until: (value) => value.elements.length === 0,
    });
  };
  const quietBell = async () => {
    const state = await world.bell();
    expect(state).toEqual({ label: "Activity", unread: false });
    await user.notSee({ role: "button", label: /Mark all.*read/i });
    return state;
  };
  await step("before: Activity shows the quiet bell empty state without an unread count", async () => {
    expect(await center()).toEqual([]);
    await user.click(bell);
    await user.see(emptyTitle);
    await user.see({ text: "When something is shared with you or changes, it shows here." });
    await user.notSee({ role: "button", label: "View all" });
    const state = await quietBell();
    evidence.recordAssertionEvidence("An empty Activity stays quiet", `0 entries; bell “${state.label}”; unread indicator ${state.unread}; Nothing new is visible and there is no View all (Paper A4)`, true);
    await user.screenshot();
    await closeCenter();
  });

  await step("after: device notices such as model or reload updates do not enter Activity", async () => {
    expect(await world.providerSync([{ id: "eng-278-sync-a", name: "Activity provider A", providerId: "eng-278-a" }])).toBe(1);
    expect(await world.providerSync([{ id: "eng-278-sync-b", name: "Activity provider B", providerId: "eng-278-b" }])).toBe(1);
    const merged = await probe.eventually(center, {
      within: 10_000, label: "background provider notices are still recorded", until: (value) => value[0]?.title === "2 new providers available",
    });
    expect(merged).toHaveLength(1);
    await user.notSee({ text: "2 new providers available" });
    await quietBell();
    await user.click(bell);
    await user.see(emptyTitle);
    await user.notSee({ text: "2 new providers available" });
    expect((await probe.dom('[data-notification-panel] [data-activity-row]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Activity holds only member changes", `${merged.length} device notice recorded for 2 providers; nothing pops up; Activity still shows Nothing new and the bell has no dot`, true);
    await user.screenshot();
    await closeCenter();
  });

  await step("Activity stays reachable with the sidebar hidden", async () => {
    await user.click({ testId: "sidebar-sidebar-toggle" });
    await probe.eventually(() => probe.dom("[data-session-header] [data-notification-bell]"), {
      within: 5_000, label: "Activity bell moves to the main titlebar", until: (value) => value.elements.length === 1,
    });
    await user.click(bell);
    await user.see(emptyTitle);
    await quietBell();
    evidence.recordAssertionEvidence("Hiding the sidebar keeps Activity reachable", `1 titlebar bell; the same quiet Activity; no unread dot`, true);
    await user.screenshot();
    await closeCenter();
    await user.click({ testId: "main-sidebar-toggle" });
  });
});
