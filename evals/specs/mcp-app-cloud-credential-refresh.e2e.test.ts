import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appTitle, chatPrompt, chatReply, launchInput, mcpAppServersChat } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServersChat, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm"] }, timeout: 600_000,
});

const pricedLine = `${launchInput.quantity} × ${launchInput.sku} at 7`;
const authFailure = /This App's connection needs authentication/;

test("an App view that failed on an expired Cloud credential loads by itself once OpenWork renews the credential", async ({ world, agent, user, probe, step, evidence }) => {
  let frame: Awaited<ReturnType<typeof world.appFrameShowing>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const retryButtons = async () => (await probe.dom("button")).elements.filter(element => element.text === "Retry").length;

  await step("before: with the App host's Cloud credential expired, the Order calculator in chat stops on a sign-in error", async () => {
    expect((await world.cloudCredentials()).liveAppHost).toBeGreaterThan(0);
    await world.expireCloudCredentials("app-host");
    expect((await world.cloudCredentials()).liveAppHost).toBe(0);
    const openedAt = new Date().toISOString();
    await agent.send(chatPrompt);
    await user.see({ text: chatReply }, { timeoutMs: 120_000 });
    await user.see({ text: authFailure }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Retry" });
    // Without a new credential the view stays on its error: nothing retries unchanged access.
    const quietUntil = Date.now() + 5_000;
    await probe.eventually(async () => {
      expect(await retryButtons()).toBe(1);
      expect(await world.inventoryCalls({ sinceIso: openedAt })).toEqual([]);
      return Date.now() >= quietUntil;
    }, { within: 15_000, label: "the App view waits on its sign-in error", until: Boolean });
    expect((await probe.dom(`[data-mcp-app-resource="${world.created.resourceUri}"] iframe`)).elements).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("An expired Cloud credential stops the App view", `After the App host's Cloud credential expired in Den, "${chatPrompt}" opened ${appTitle} in chat, and the card shows "This App's connection needs authentication" with one Retry button. For 5 seconds no App frame loaded and Inventory got no lookup.`, true);
  });

  await step("after: once OpenWork renews the Cloud credential in the background, the same App view loads with no Retry click", async () => {
    // The rest of the credential expires too, so the desktop's background Cloud check must renew it.
    await world.expireCloudCredentials("all");
    const expired = await world.cloudCredentials();
    expect(expired.live).toBe(0);
    const refreshedAt = new Date().toISOString();
    await world.returnToWindow();
    const renewed = await probe.eventually(() => world.cloudCredentials(), {
      within: 90_000, intervalMs: 1_000, label: "OpenWork mints a new Cloud credential",
      until: credentials => credentials.total > expired.total && credentials.liveAppHost > 0,
    });
    frame = await world.appFrameShowing(appTitle, pricedLine);
    const calculator = user.on(frame);
    await calculator.see({ testId: "order-line" }, { text: pricedLine });
    await user.notSee({ text: authFailure });
    // The spec never clicks Retry; the view recovered on its own and no Retry button remains.
    expect(await retryButtons()).toBe(0);
    expect((await probe.dom(`[data-mcp-app-resource="${world.created.resourceUri}"] iframe`)).elements).toHaveLength(1);
    expect((await world.inventoryCalls({ sinceIso: refreshedAt, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    await user.screenshot();
    evidence.recordAssertionEvidence("A renewed Cloud credential reloads the App view by itself", `With every Cloud credential expired, the owner came back to OpenWork and its background check minted ${renewed.total - expired.total} new Cloud tokens in Den and installed them. Without any Retry click, the same ${appTitle} card left its sign-in error, loaded the App, and its Inventory lookup ran once, so the order line reads "${pricedLine}".`, true);
  });
});
