import { addInitScript, browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

declare global {
  interface Window { __selectedSkillPrompts?: unknown[] }
}

/**
 * A transparent provider-boundary witness: records exactly what the native
 * engine sends, then forwards it unchanged to the standard model mock.
 */
export async function startProviderWitnessProxy(upstreamUrl: string) {
  const providerRequests: unknown[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (body) providerRequests.push(JSON.parse(body));
      const upstream = await fetch(`${upstreamUrl}${request.url}`, {
        method: request.method, headers: { "content-type": "application/json" },
        ...(body ? { body } : {}),
      });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      const reader = upstream.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      response.end();
    } catch { response.writeHead(502); response.end("Provider witness failed"); }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing provider witness port");
  const dispose = async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  };
  return { port: address.port, providerRequests, dispose };
}

/** Explicit selection, not model-initiated discovery. No Den or Electron. */
export function selectedSkillsWeb(seed: Seed) {
  return selectedSkillsIn(seed, "workspace");
}

/** The same contract with the skill only in the person's global OpenCode skills folder. */
export function selectedGlobalSkillsWeb(seed: Seed) {
  return selectedSkillsIn(seed, "global");
}

async function selectedSkillsIn(seed: Seed, folder: "workspace" | "global") {
  const skillName = "selected-briefing";
  const skillBody = "When preparing a briefing, include the exact phrase AMBER_BODY_ONLY_7391. Keep the briefing concise.";
  const copyBody = "When preparing a briefing, include the exact phrase COPY_BODY_ONLY_5120. Keep the briefing long.";
  const prompt = "Prepare a short briefing.";
  const reply = "The briefing is ready.";
  const workspacePath = seed.tmpPath("selected-skills");
  // A global skill lives in OpenCode's own folder under a home this world owns.
  const home = folder === "global" ? seed.tmpPath("selected-skills-home") : null;
  const skillDirectory = home
    ? join(home, ".config", "opencode", "skills", skillName)
    : join(workspacePath, ".opencode", "skills", skillName);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: ${skillName}\ndescription: Prepare a concise briefing.\n---\n${skillBody}\n`);
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: prompt, latestUserTurn: true, finalReply: reply,
    steps: [],
  }] });
  const app = await seed.appWeb({ name: "selected-skills", workspacePath, mocks: { agent: mock }, ...(home ? { env: { HOME: home } } : {}) });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing selected-skills provider witness");
  const { port, providerRequests, dispose } = await startProviderWitnessProxy(witness.url);
  try {
    await addInitScript(app.client, () => {
      window.__selectedSkillPrompts = [];
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        const pathname = new URL(request.url).pathname;
        if (request.method === "POST" && /\/(?:prompt|permission)$/.test(pathname)) {
          window.__selectedSkillPrompts?.push({ kind: pathname.endsWith("/permission") ? "permission" : "prompt", body: await request.clone().json() });
        }
        return original(input, init);
      };
    });
    const workspace = await seed.workspace(app, workspacePath);
    const providerId = "selected-skill-witness";
    const modelId = "briefing-model";
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      permission: { skill: "allow" },
      provider: { [providerId]: {
        npm: "@ai-sdk/openai-compatible", name: "Selected skill witness",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-skill-key" },
        models: { [modelId]: { name: "Briefing witness", tool_call: true } },
      } },
    });
    // Native catalog readiness is not renderer hydration. Do not create the
    // fixture session until the real composer has the arranged model.
    const ready = await seed.evalIn(app, async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (document.querySelector('[aria-label="Change model"]')?.textContent?.includes("Briefing witness")) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, { awaitPromise: true, timeoutMs: 35_000 });
    if (!ready) throw new Error("Selected-skill composer did not hydrate the fixture model");
    const session = await seed.session(app, { title: "Selected skill contract" });
    return {
      app, workspace, session, skillName, skillBody, prompt, reply, modelId, workspacePath, skillDirectory,
      removeSkill: () => rm(skillDirectory, { recursive: true }),
      copyBody,
      /** A renamed copy of the skill folder keeps its frontmatter name, as copying a skill does. */
      addRenamedCopy: async () => {
        const directory = join(workspacePath, ".claude", "skills", `${skillName}-copy`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), `---\nname: ${skillName}\ndescription: An older copy of the briefing skill.\n---\n${copyBody}\n`);
      },
      /** Native-boundary requests the app made, in order: permission asks and prompt submissions. */
      nativeRequests: async () => {
        const entries = await seed.evalIn(app, () => window.__selectedSkillPrompts ?? []);
        return entries.flatMap((entry) => isRecord(entry) && (entry.kind === "permission" || entry.kind === "prompt")
          ? [{ kind: entry.kind, body: entry.body }] : []);
      },
      providerRequests: () => providerRequests,
      modelRequests: () => witness.agentRequests({ promptMarker: prompt }),
      runtimeFacts: () => seed.evalIn(app, () => ({ browser: navigator.userAgent, electronBridge: Boolean(window.__OPENWORK_ELECTRON__) })),
      readNative: (path: string) => seed.evalIn(app, browserScript(async (path) => {
        const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + path, {
          headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
          signal: AbortSignal.timeout(15_000),
        });
        const body: unknown = await response.json();
        return { status: response.status, body };
      }, [path]), { awaitPromise: true, timeoutMs: 20_000 }),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
