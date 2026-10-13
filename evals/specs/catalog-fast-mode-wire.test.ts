import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eventually, test } from "@openwork/testkit";
import { expect } from "vitest";
import { CATALOG_FAST_VARIANT, FAST_VARIANT_PREFIX, fastVariantId } from "@openwork/types/cloud-model-fast";
import { buildCloudProviderConfig } from "../../apps/app/src/react-app/domains/connections/provider-auth/cloud-provider-config";

import versions from "../../constants.json";
import { createManagedOpencodeV2Server, installOpencodeV2Binary } from "../../apps/server/src/managed-opencode-v2";

const exec = promisify(execFile);
const advertisedEfforts = ["low", "medium", "high", "xhigh", "max"];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The verified engine must preserve exact wire model IDs and effort.
// Stored metadata stays disabled until rendered for the pinned engine.
test("v2 dispatches catalog Fast independently of effort", { timeout: 180_000 }, async ({ evidence }) => {
  const binary = process.env.OPENWORK_EVAL_OPENCODE2_BIN ?? await installOpencodeV2Binary(
    join(tmpdir(), "openwork-opencode-v2-verified"), versions.opencodeV2Version,
  );
  expect((await exec(binary, ["--version"])).stdout.trim()).toBe(`opencode v${versions.opencodeV2Version}`);

  const requests: { model: unknown; effort: unknown; effortUpdates: unknown[]; tier: unknown; verbosity: unknown; generation: boolean }[] = [];
  const witness = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/v1/responses" && isRecord(body)) {
      // Stable V2 sends GPT-6 effort changes as ordered input updates, not
      // just the request-level reasoning field. The last update is effective.
      const effortUpdates = Array.isArray(body.input) ? body.input.flatMap((item: unknown) =>
        isRecord(item) && item.type === "configuration_update" && isRecord(item.reasoning)
          ? [item.reasoning.effort] : []) : [];
      requests.push({ model: body.model,
        effort: effortUpdates.at(-1) ?? (isRecord(body.reasoning) ? body.reasoning.effort ?? null : null),
        effortUpdates, tier: body.service_tier ?? null, verbosity: isRecord(body.text) ? body.text.verbosity ?? null : null,
        generation: Array.isArray(body.tools) && body.tools.length > 0 });
    }
    // Capture dispatch only: never run a real model or execute a tool. A 400
    // is intentional and non-retryable; successful completion is not claimed.
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic wire witness", type: "invalid_request_error" } }));
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Witness did not bind");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), "catalog-fast-wire-"));
  const directory = join(root, "workspace");
  await mkdir(directory);
  const configPath = join(root, "base.json");
  const rawModelConfig = {
    name: "Synthetic mode witness", reasoning: true, release_date: "2026-09-04", limit: { context: 128_000, output: 8_192 },
    reasoning_options: [{ type: "effort", values: advertisedEfforts }],
    // Exercise Default + Fast's merge with an existing model option without
    // pinning a reasoning effort or changing the actual wire model ID.
    options: { textVerbosity: "high" },
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
    experimental: { modes: { fast: {
      provider: { body: { service_tier: "priority" } }, cost: { input: 20, output: 100, cache_read: 2, cache_write: 25 },
    } } },
  };
  const provider = buildCloudProviderConfig({
    id: "lpr_witness", providerId: "openai", source: "custom", name: "Synthetic witness",
    providerConfig: { npm: "@ai-sdk/openai", options: { apiKey: "synthetic-only", baseURL: `${baseURL}/v1` } },
    hasApiKey: true, apiKey: "synthetic-only", apiKeys: null, createdAt: null, updatedAt: null,
    models: [
      { id: "gpt-6-astra", name: "Synthetic mode witness", config: rawModelConfig, createdAt: null },
      { id: "gwm_synthetic", name: "Opaque gateway alias", config: rawModelConfig, createdAt: null },
      { id: "gpt-5.4", name: "GPT-5.4 control", createdAt: null,
        config: { ...rawModelConfig, reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] } },
    ],
  });
  const models = provider.models ?? {};
  // Isolate provider dispatch from unrelated OpenWork plugins in this test.
  await writeFile(configPath, JSON.stringify({}));
  const env = {
    HOME: root, OPENCODE_CONFIG: configPath, OPENCODE_MODELS_URL: baseURL,
    OPENCODE_DISABLE_MODELS_FETCH: "1", XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const server = await createManagedOpencodeV2Server({ bin: binary, rootDir: root, env });
  try {
    await server.injectProvider({
      id: "witness", name: "Synthetic witness", apiKey: "synthetic-only",
      baseUrl: `${baseURL}/v1`, package: "@opencode/ai/providers/openai",
      settings: { transport: "http" },
      models: Object.entries(models).map(([id, config]) => ({ id, name: config.name ?? id, config })),
    });
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const url = new URL(path, server.url);
      url.searchParams.set("location[directory]", directory);
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", authorization:
          `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}` },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      }).catch((error: unknown) => {
        throw new Error(`v2 ${body === undefined ? "GET" : "POST"} ${path} failed`, { cause: error });
      });
      if (body !== undefined && path.endsWith("/model")) {
        expect(response.status).toBe(204);
        return undefined;
      }
      expect(response.status).toBe(200);
      return response.json();
    };
    const catalog = await eventually(
      async () => JSON.stringify(await request("/api/model")),
      { within: 15_000, intervalMs: 100, label: "watched provider config becomes visible", until: (value) => value.includes("gpt-6-astra") },
    );
    expect(catalog).not.toContain(CATALOG_FAST_VARIANT);
    expect(catalog).toContain(fastVariantId("high"));
    const payload: unknown = JSON.parse(catalog);
    for (const modelId of Object.keys(models)) {
      const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
      const model = entries.find((entry) => isRecord(entry) && entry.id === modelId);
      const variants = isRecord(model) && Array.isArray(model.variants)
        ? model.variants.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])
        : [];
      const efforts = modelId === "gpt-5.4" ? advertisedEfforts.filter((effort) => effort !== "max") : advertisedEfforts;
      expect(variants.sort()).toEqual([...efforts, fastVariantId(null), ...efforts.map(fastVariantId)].sort());
      evidence.recordAssertionEvidence(`v2 ${modelId} exposes only advertised efforts and Fast combinations`, JSON.stringify(variants), true);
    }
    const dispatches: { model: string; variant: string | null; effort: unknown; effortUpdates: unknown[]; tier: unknown; verbosity: unknown }[] = [];
    for (const model of Object.keys(models)) {
      const created = await request("/api/session", { location: { directory }, model: { providerID: "witness", id: model } });
      const data = isRecord(created) ? created.data : created;
      if (!isRecord(data) || typeof data.id !== "string") throw new Error("Session ID missing");
      expect(data.location).toEqual({ directory });
      const sessionID = data.id;
      const selections: Array<string | null> = [
        "high", fastVariantId("high"), fastVariantId("low"), "low",
        ...(model === "gpt-5.4" ? ["medium", "xhigh"] : ["medium", "xhigh", "max"]).flatMap((effort) => [effort, fastVariantId(effort)]),
        null, fastVariantId(null), null,
      ];
      for (const variant of selections) {
        await request(`/api/session/${sessionID}/model`, { model: {
          providerID: "witness", id: model, ...(variant === null ? {} : { variant }),
        } });
        const offset = requests.length;
        await request(`/api/session/${data.id}/prompt`, { text: "Reply hello." });
        const dispatched = await eventually(
          () => requests.slice(offset).find((entry) => entry.model === model && entry.generation),
          { within: 30_000, intervalMs: 100, label: `v2 ${model} ${variant} reaches the wire`, until: (value) => value !== undefined },
        );
        if (!dispatched) throw new Error("No generation request reached the witness");
        dispatches.push({ model, variant, effort: dispatched.effort, effortUpdates: dispatched.effortUpdates,
          tier: dispatched.tier, verbosity: dispatched.verbosity });
        await eventually(async () => {
          const active = await request("/api/session/active");
          if (!isRecord(active) || !isRecord(active.data)) return false;
          const session = active.data[sessionID];
          return !isRecord(session) || session.type !== "running";
        }, { within: 30_000, intervalMs: 100, label: "synthetic request settles before the next selection", until: (value) => value });
      }
    }
    evidence.recordAssertionEvidence("Synthetic provider wire dispatches", JSON.stringify({ engine: "v2", dispatches }), true);
    expect(dispatches.some((row) => row.model === "gpt-6-astra" && row.effortUpdates.length > 0),
      "GPT-6 sends per-turn effort updates on the wire").toBe(true);
    for (const row of dispatches) {
      // A GPT-6 reset update explicitly uses medium; with no update the
      // default is implicit. Neither path may retain the previous effort.
      const expectedEffort = advertisedEfforts.find((effort) => row.variant === effort || row.variant === fastVariantId(effort))
        ?? (row.model === "gpt-5.4" || row.effortUpdates.length > 0 ? "medium" : null);
      if (row.effortUpdates.length > 0) {
        expect(row.effortUpdates.at(-1), "GPT-6's latest input update controls effort").toBe(expectedEffort);
      }
      expect(row.effort, `v2 ${row.model} ${row.variant}: reasoning effort on the wire`).toBe(expectedEffort);
      expect(row.verbosity).toBe("high");
      expect(row.tier, `v2 ${row.model} ${row.variant}: service_tier on the wire`)
        .toBe(row.variant?.startsWith(FAST_VARIANT_PREFIX) ? "priority" : null);
    }
  } finally {
    await server.close();
    witness.closeAllConnections();
    await new Promise<void>((resolve, reject) => witness.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
