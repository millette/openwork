import { expect } from "vitest";
import { SkipError, spec } from "@openwork/testkit";
import type { Probe, Target, User } from "@openwork/testkit";
import { computerUseWorld } from "../worlds/desktop-chat-features.ts";

/**
 * Computer use on this Mac, behind the `computerUse` feature. The Computer
 * button renders only in the macOS desktop app, and readiness comes from the
 * bundled helper's own probe of the macOS Accessibility and Screen Recording
 * permissions (TCC). Those are granted by a person in System Settings; nothing
 * here grants, fakes or stubs them.
 *
 * The first journey needs no permissions: it proves the chat starts off, shows
 * what this Mac reports, and cannot be allowed before macOS access is verified.
 * The second journey changes consent, which the app only offers once the helper
 * reports both permissions; on a Mac without them it skips with that reason.
 */
const test = spec.world(computerUseWorld, {
  resources: {
    surfaces: ["desktop"],
    services: ["den"],
    nativeReason: "Computer use is an Electron main-process broker over a bundled macOS helper that probes Accessibility and Screen Recording; only the macOS desktop app renders it.",
  },
  needs: { platform: "darwin", placement: "local" },
});

const button: Target = { testId: "session-computer-control" };
const popover: Target = { testId: "session-computer-popover" };
const status: Target = { testId: "session-computer-status" };
const READINESS = ["ready", "setup-required", "unsupported", "unavailable"] as const;
type Readiness = typeof READINESS[number];
const WITHIN = 15_000;

/** The header button's state and whether it shows the green "allowed" dot. */
async function headerState(probe: Probe, state: "off" | "allowed" | "attention", dot: boolean) {
  await probe.eventually(async () => ({
    state: (await probe.dom(`[data-testid="session-computer-control"][data-state="${state}"]`)).elements.length,
    dot: (await probe.dom('[data-testid="session-computer-control"] span[aria-hidden]')).elements.length,
  }), { within: WITHIN, until: (value) => value.state === 1 && value.dot === (dot ? 1 : 0), label: `the Computer button is ${state}${dot ? " with its green dot" : ""}` });
}

/** What the helper reports for this Mac, as the popover shows it. */
async function readiness(probe: Probe): Promise<Readiness> {
  return probe.eventually(async () => {
    for (const value of READINESS) {
      if ((await probe.dom(`[data-testid="session-computer-readiness"][data-state="${value}"]`)).elements.length === 1) return value;
    }
    return null;
  }, { within: 30_000, until: (value) => value !== null, label: "the popover reports this Mac's readiness" }) as Promise<Readiness>;
}

async function openPopover(user: User) {
  await user.click(button);
  await user.see(popover);
}

const switchChecked = async (probe: Probe, checked: boolean) => {
  await probe.eventually(() => probe.dom(`[data-testid="session-computer-always-allow"]${checked ? "[data-checked]" : "[data-unchecked]"}`), {
    within: WITHIN, until: (dom) => dom.elements.length === 1, label: `Always allow is ${checked ? "on" : "off"}`,
  });
};

test("a person on a Mac finds computer use off in a new chat and sees what macOS still needs", async ({ user, probe, step, evidence }) => {
  let ready: Readiness = "unavailable";

  await step("before: a new chat shows the Computer button off", async () => {
    await user.see({ role: "button", label: "Computer use: Off for this chat" }, { timeoutMs: 60_000 });
    await headerState(probe, "off", false);
    await user.notSee({ testId: "session-computer-floating" });
    evidence.recordAssertionEvidence(
      "Computer use starts off for a new chat",
      "The chat header shows the Computer button labelled \"Off for this chat\", with no green dot and no Computer view.",
      true,
    );
    await user.screenshot();
  });

  await step("the Computer popover says this chat is off and whether this Mac is ready", async () => {
    await openPopover(user);
    await user.see(status, { text: "Off for this chat" });
    ready = await readiness(probe);
    await user.see({ testId: "session-computer-readiness" }, { text: /^This Mac · (Ready|Setup needed|Unsupported|Unavailable)$/ });
    evidence.recordAssertionEvidence(
      "The popover reports this Mac's readiness",
      `Status reads "Off for this chat"; the bundled helper reports this Mac as ${ready}.`,
      true,
    );
    await user.screenshot();
  });

  await step("the chat stays off until the person allows it", async () => {
    await user.see({ testId: "session-computer-allow" }, { text: "Allow for this chat" });
    await switchChecked(probe, false);
    expect((await probe.dom('[data-testid="session-computer-always-allow"][data-disabled]')).elements).toHaveLength(0);
    if (ready === "setup-required") await user.see({ text: /^macOS needs two permissions for .+ first\.$/ });
    await user.see(status, { text: "Off for this chat" });
    await headerState(probe, "off", false);
    evidence.recordAssertionEvidence(
      "Nothing turns computer use on by itself",
      `"Allow for this chat" and Always allow are offered (this Mac reports ${ready}), and the chat stays off until the person chooses one.`,
      true,
    );
    await user.screenshot();
  });

  await step("the setup checklist names the macOS entry and shows each permission as the helper verified it", async () => {
    if (ready === "unsupported") {
      expect((await probe.dom('[data-testid="session-computer-setup"]:disabled')).elements).toHaveLength(1);
      evidence.recordAssertionEvidence("Setup is not offered on an unsupported Mac", "This Mac is unsupported, so the permissions guide button is disabled.", true);
      await user.screenshot();
      return;
    }
    await user.click({ testId: "session-computer-setup" });
    await user.see({ testId: "session-computer-setup-dialog" });
    await user.see({ text: "Set up computer use" });
    const row = async (item: string) => {
      expect((await probe.dom(`[data-testid="session-computer-permission-${item}"]`)).elements).toHaveLength(1);
      for (const state of ["done", "waiting", "todo"]) {
        if ((await probe.dom(`[data-testid="session-computer-permission-${item}"][data-state="${state}"]`)).elements.length === 1) return state;
      }
      return "unknown";
    };
    const accessibility = await row("accessibility");
    const screenRecording = await row("screenRecording");
    expect(await row("chat")).toBe("todo");
    if (ready === "ready") expect([accessibility, screenRecording]).toEqual(["done", "done"]);
    else if (ready === "setup-required") expect([accessibility, screenRecording]).toContain("todo");
    // The checklist names the exact entry macOS lists, never a guess between two apps.
    const entry = (await probe.dom('[data-testid="session-computer-entry"]')).elements[0]?.text ?? "";
    if (ready !== "ready" || accessibility !== "done") expect(entry).not.toBe("");
    evidence.recordAssertionEvidence(
      "The checklist shows both macOS permissions as the helper verified them and names the entry to turn on",
      `Accessibility: ${accessibility}; Screen Recording: ${screenRecording}; this chat: not allowed yet (this Mac reports ${ready}). Entry to turn on: "${entry}". Opening the checklist changed nothing.`,
      true,
    );
    await user.screenshot();
    await user.press("Escape");
    await user.notSee({ testId: "session-computer-setup-dialog" });
    await headerState(probe, "off", false);
  });
});

test("a person allows computer use for one chat, then for every chat, and stops it", async ({ user, probe, step, evidence }) => {
  // Allowing a chat is the person's choice in OpenWork and does not need the
  // macOS permissions; those stay a System Settings choice the test never makes.
  await user.see({ role: "button", label: "Computer use: Off for this chat" }, { timeoutMs: 60_000 });
  await openPopover(user);
  const ready = await readiness(probe);
  if (ready === "unsupported" || ready === "unavailable") {
    await user.press("Escape");
    throw new SkipError(`computer use needs macOS 14 or later with the OpenWork Computer Use helper (this Mac reports ${ready})`);
  }

  await step("before: the chat is still off", async () => {
    await user.see(status, { text: "Off for this chat" });
    await user.see({ testId: "session-computer-allow" }, { text: "Allow for this chat" });
    await headerState(probe, "off", false);
    evidence.recordAssertionEvidence("Each chat starts off", `The chat reads "Off for this chat" with no green dot (this Mac reports ${ready}).`, true);
    await user.screenshot();
  });

  await step("after: Allow for this chat turns the Computer button on with a green dot", async () => {
    await user.click({ testId: "session-computer-allow" });
    await user.see(status, { text: "Allowed for this chat" });
    await headerState(probe, "allowed", true);
    await user.see({ testId: "session-computer-stop" }, { text: "Stop & revoke" });
    await user.notSee({ testId: "session-computer-allow" });
    await switchChecked(probe, false);
    evidence.recordAssertionEvidence(
      "Allowing one chat turns it on and keeps it on",
      "Status reads \"Allowed for this chat\"; the header button shows its green dot, Allow is no longer offered and Always allow stays off.",
      true,
    );
    await user.screenshot();
  });

  await step("after: Stop & revoke turns this chat off again", async () => {
    await user.click({ testId: "session-computer-stop" });
    await user.see(status, { text: "Off for this chat" });
    await headerState(probe, "off", false);
    await user.see({ testId: "session-computer-allow" });
    evidence.recordAssertionEvidence(
      "Stop & revoke ends this chat's access",
      "Status is back to \"Off for this chat\"; the green dot is gone and \"Allow for this chat\" is offered again.",
      true,
    );
    await user.screenshot();
  });

  await step("after: Always allow turns the chat on without asking", async () => {
    await user.click({ testId: "session-computer-always-allow" });
    await switchChecked(probe, true);
    await user.see(status, { text: "Always allowed" });
    await headerState(probe, "allowed", true);
    evidence.recordAssertionEvidence(
      "Always allow enables the chat",
      "The Always allow switch is on, status reads \"Always allowed\" and the header button shows its green dot.",
      true,
    );
    await user.screenshot();
  });

  await step("turning Always allow off keeps this chat allowed, and Stop & revoke turns it off", async () => {
    await user.click({ testId: "session-computer-always-allow" });
    await switchChecked(probe, false);
    await user.see(status, { text: "Allowed for this chat" });
    await headerState(probe, "allowed", true);
    await user.click({ testId: "session-computer-stop" });
    await user.see(status, { text: "Off for this chat" });
    await headerState(probe, "off", false);
    evidence.recordAssertionEvidence(
      "Turning Always allow off never takes away a chat the person is using",
      "With the switch off, this chat still reads \"Allowed for this chat\"; Stop & revoke then turns it off and leaves the test profile clean.",
      true,
    );
    await user.screenshot();
  });
});
