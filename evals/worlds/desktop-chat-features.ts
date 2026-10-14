import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * A signed-in desktop whose organization has one or more desktop chat
 * features switched on before the app starts, with one chat on screen.
 * Desktop features follow the active organization's features (`GET /v1/org`),
 * so the switch is the same platform-admin capability route other worlds use.
 */
async function featureDesktop(seed: Seed, name: string, capabilities: Record<string, true>, title: string) {
  const den = await seed.den({ org: { name: "Desktop features studio", admin: { name: "Workspace Owner" } } });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, capabilities);
  const app = await seed.desktop({ name, den, as: "admin" });
  const session = await seed.session(app, { title });
  return { den, organizationId, app, session };
}

/** The floating browser presentation, with a page origin the built-in browser can always reach. */
export async function browserFloatingViewWorld(seed: Seed) {
  const world = await featureDesktop(seed, "browser-floating-view", { browserFloatingView: true }, "Comparing release notes");
  // The embedded OpenWork server answers any path, so the page is local and deterministic.
  const info = await seed.evalIn(world.app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo"), { awaitPromise: true });
  if (!info || typeof info !== "object" || !("baseUrl" in info) || typeof info.baseUrl !== "string" || !info.baseUrl) {
    throw new Error("The embedded OpenWork server is unavailable.");
  }
  const origin = info.baseUrl.replace(/\/+$/, "");
  return { ...world, origin, pageUrl: `${origin}/?floating-browser=release-notes` };
}

/** Computer use on this Mac. Readiness comes from the real helper and macOS permissions; nothing is faked. */
export async function computerUseWorld(seed: Seed) {
  return featureDesktop(seed, "computer-use-consent", { computerUse: true }, "Tidy the project folder");
}
