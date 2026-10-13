import { createServer } from "node:http";
import { afterEach, expect } from "vitest";
import { test } from "@openwork/testkit";
import { openworkCatalogModels } from "@openwork/types/openwork-affordance";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { openworkReadTransport, type OpenworkReadTransport } from "../../apps/server/src/opencode-plugins/openwork-read-transport";
import { createV2ReadAdapter, readV2SessionActivity } from "../../apps/server/src/opencode-v2-read-adapter";
import { listControlSessions, type ListControlSessionsState } from "../../apps/app/src/react-app/domains/session/control/list-control-sessions";

const PROVIDER = "ipr_fixture_01";
const MODEL = "gwm_fixture_01";
const OTHER_PROVIDER = "ipr_fixture_02";
const OTHER_MODEL = "gwm_fixture_02";
const STALE_MODEL = "gwm_fixture_removed";
const NAME = "Fixture Luna";
const SECRET = "synthetic-provider-secret-must-not-escape";
const workspaces = [
  { id: "ws_one", name: "One", path: "/tmp/model-alias-fixture/one" },
  { id: "ws_two", name: "Two", path: "/tmp/model-alias-fixture/two" },
];

function catalog(name = NAME): Parameters<typeof openworkCatalogModels>[0] {
  return {
    connected: [PROVIDER, OTHER_PROVIDER],
    all: [
      { id: PROVIDER, name: "Fixture Managed", models: { [MODEL]: { name }, unnamed: {} } },
      { id: OTHER_PROVIDER, name: "Fixture Alternate", models: { [OTHER_MODEL]: { name: "Fixture Shared" } } },
      { id: "disconnected", name: "Offline", models: { hidden: { name } } },
    ],
  };
}

/** OpenCode v2 lists only connected providers, and their models with provider ids. */
function nativeCatalog(value: Parameters<typeof openworkCatalogModels>[0]) {
  const connected = value.all.filter((provider) => value.connected.includes(provider.id));
  return {
    models: connected.flatMap((provider) => Object.entries(provider.models).map(([id, model]) => ({ id, providerID: provider.id, ...(model.name ? { name: model.name } : {}) }))),
    providers: connected.map((provider) => ({ id: provider.id, name: provider.name })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}

function resultOf(output: string, id: string) {
  const envelope = record(JSON.parse(output));
  expect(envelope).toMatchObject({ ok: true, id });
  const result = record(envelope.result);
  expect(result.ok).toBe(true);
  return result;
}

type Message = { id: string; type: string; time: { created: number }; content: Array<{ type: string; text: string }>; error?: unknown };
type NativeSession = { id: string; title: string; location: { directory: string }; model?: { providerID: string; id: string; variant: string } };

let clock = 100;
function message(id: string, role: string, text: string, error?: unknown): Message {
  clock += 1;
  return { id, type: role, time: { created: clock }, content: text ? [{ type: "text", text }] : [], ...(error === undefined ? {} : { error }) };
}

/** One native page: `limit` rows from the cursor on, and the next cursor until the rows run out. */
function page<T>(rows: T[], url: URL) {
  const start = Number(url.searchParams.get("cursor") ?? 0);
  const end = start + Number(url.searchParams.get("limit") ?? 200);
  return { data: rows.slice(start, end), cursor: { next: end < rows.length ? String(end) : null } };
}

const cleanups: Array<() => Promise<void>> = [];
async function cleanupWitnesses() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
afterEach(cleanupWitnesses);

/** The OpenWork host and each workspace's OpenCode v2 mount, read the way the engine's context bridge reads them. */
async function witness() {
  const requests: Array<{ path: string; search: string; method: string; body: unknown }> = [];
  const unexpected: string[] = [];
  const catalogs = new Map(workspaces.map((workspace) => [workspace.id, catalog(workspace.id === "ws_one" ? NAME : "Workspace Two Luna")]));
  const unavailable = new Set<string>();
  const host: { response?: unknown; denied: Set<string> } = { denied: new Set() };
  const transcripts = new Map<string, Message[]>();
  const one = { directory: workspaces[0].path };
  const sessions = new Map<string, NativeSession>([
    ["ses_bound", { id: "ses_bound", location: one, title: "Bound fixture", model: { providerID: PROVIDER, id: MODEL, variant: "high" } }],
    ["ses_stale", { id: "ses_stale", location: one, title: "Stale fixture", model: { providerID: PROVIDER, id: STALE_MODEL, variant: "low" } }],
    ["ses_unbound", { id: "ses_unbound", location: one, title: "Unbound fixture" }],
  ]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      request.setEncoding("utf8");
      let text = "";
      for await (const chunk of request) text += String(chunk);
      const body: unknown = text ? JSON.parse(text) : null;
      const method = request.method ?? "GET";
      requests.push({ path: url.pathname, search: url.search, method, body });
      if (request.headers.authorization !== "Bearer fixture-token") {
        unexpected.push("unauthorized fixture request");
        return json(401, { message: "Unauthorized" });
      }
      if (method === "GET" && url.pathname === "/workspaces") return json(200, { items: workspaces });
      if (method === "POST" && url.pathname === "/experimental/ui-control/request") {
        const bridge = record(body);
        const input = record(bridge.input);
        if (bridge.kind === "query" && input.id === "models.list") {
          if (host.response !== undefined) return json(200, host.response);
          const args = record(input.args);
          const workspace = workspaces.find((entry) => entry.id === args.workspaceId);
          const value = workspace ? catalogs.get(workspace.id) : undefined;
          if (!workspace || !value) return json(200, { ok: false, id: "models.list", code: "invalid-args", error: "Workspace missing" });
          if (unavailable.has(workspace.id)) return json(200, { ok: false, id: "models.list", code: "unavailable", error: "Fixture catalog unavailable" });
          const models = host.denied.has(workspace.id) ? [] : openworkCatalogModels(value);
          return json(200, { ok: true, id: "models.list", effects: { data: "read", ui: "none", external: false },
            result: { ok: true, workspaceId: workspace.id, models: models.map((model) => ({ ...model, available: true })) } });
        }
      }
      const route = /^\/workspace\/([^/]+)\/opencode2\/api(\/.*)$/.exec(url.pathname);
      const workspace = workspaces.find((entry) => entry.id === route?.[1]);
      const path = route?.[2];
      if (workspace && path && method === "GET") {
        const value = catalogs.get(workspace.id);
        if (path === "/model" || path === "/provider") {
          if (unavailable.has(workspace.id) || !value) return json(503, { message: "Fixture catalog unavailable" });
          const native = nativeCatalog(value);
          return json(200, { data: path === "/model" ? native.models : native.providers });
        }
        const owned = [...sessions.values()].filter((session) => session.location.directory === workspace.path);
        if (path === "/session") return json(200, page(owned, url));
        if (path === "/session/active") return json(200, { data: {} });
        const sessionRoute = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
        const session = owned.find((candidate) => candidate.id === sessionRoute?.[1]);
        if (session) {
          const suffix = sessionRoute?.[2];
          if (!suffix) return json(200, { data: session });
          // Like the engine: pages run newest first, so `limit` alone is the newest window.
          if (suffix === "/message") return json(200, page((transcripts.get(session.id) ?? []).toReversed(), url));
          if (suffix === "/permission" || suffix === "/form") return json(200, { data: [] });
        }
      }
      unexpected.push(`${method} ${url.pathname}`);
      return json(404, { message: "Unexpected fixture route" });
    } catch {
      unexpected.push(`invalid fixture request: ${url.pathname}`);
      return json(500, { message: "Invalid fixture request" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    expect(unexpected).toEqual([]);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to bind");
  const base = `http://127.0.0.1:${address.port}`;
  const send = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: "Bearer fixture-token", "content-type": "application/json" } });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(isRecord(payload) && typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`);
    return payload;
  };
  const read = (path: string) => send(path);
  const transport: OpenworkReadTransport = {
    get: createV2ReadAdapter(read),
    activity: (workspaceId, sessionId) => readV2SessionActivity(read, workspaceId, sessionId),
    post: (path, body, signal) => send(path, { method: "POST", body: JSON.stringify(body), signal }),
  };
  const plugin = await OpenWorkExtensionsPreview({ directory: workspaces[0].path });
  const query = (id: string, args: Record<string, unknown>) =>
    openworkReadTransport.run(transport, () => plugin.tool.openwork_query.execute({ id, args }));
  return {
    requests, catalogs, sessions, transcripts, unavailable, host,
    hostQueries: () => requests.filter((request) => isRecord(request.body) && request.body.kind === "query"),
    writes: () => requests.filter((request) => request.method !== "GET" && !(isRecord(request.body) && request.body.kind === "query")),
    query,
    read: async (sessionId: string, args: Record<string, unknown> = {}) => resultOf(await query("session.read", { workspaceId: "ws_one", sessionId, ...args }), "session.read"),
  };
}

test("session model aliases preserve workspace scope, canonical bindings, and safe read projections", async ({ evidence }) => {
  const cases: Array<{ name: string; run: () => Promise<void> }> = [];
  const modelCase = (name: string, run: () => Promise<void>) => { cases.push({ name, run }); };

modelCase("models.list returns only connected models from the explicitly requested workspace", async () => {
  const fake = await witness();
  const output = await fake.query("models.list", { workspaceId: "ws_two" });
  const result = resultOf(output, "models.list");
  expect(result).toEqual({ ok: true, workspaceId: "ws_two", models: [
    { providerId: PROVIDER, modelId: MODEL, displayName: "Workspace Two Luna", providerName: "Fixture Managed", available: true },
    { providerId: PROVIDER, modelId: "unnamed", displayName: "unnamed", providerName: "Fixture Managed", available: true },
    { providerId: OTHER_PROVIDER, modelId: OTHER_MODEL, displayName: "Fixture Shared", providerName: "Fixture Alternate", available: true },
  ] });
  expect(record(JSON.parse(output)).effects).toEqual({ data: "read", ui: "none", external: false });
  expect(fake.requests.map((request) => request.path)).toEqual(["/experimental/ui-control/request"]);
  expect(fake.hostQueries().map((request) => request.body)).toEqual([{ kind: "query", input: { id: "models.list", args: { workspaceId: "ws_two" } } }]);
  expect(fake.writes()).toEqual([]);
  const missing = record(JSON.parse(await fake.query("models.list", {})));
  expect(missing).toMatchObject({ ok: false, id: "models.list" });
  expect(record(JSON.parse(await fake.query("models.list", { workspaceId: "ws_missing" })))).toMatchObject({ ok: false, id: "models.list" });
  expect(fake.requests.filter((request) => request.path.includes("/opencode2/"))).toHaveLength(0);
  evidence.recordAssertionEvidence("Catalog discovery is workspace-scoped and read-only", "The non-caller workspace returned its three connected models and fallback name; disconnected models, caller catalog reads, writes, and missing-workspace fallback were absent.", fake.writes().length === 0 && records(result.models).length === 3);
});

modelCase("session.read adds current names without rewriting stale ids or inventing unbound models", async () => {
  const fake = await witness();
  const before = JSON.stringify([...fake.sessions.entries()]);
  expect((await fake.read("ses_bound")).model).toEqual({ providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: NAME, providerName: "Fixture Managed" });
  fake.catalogs.set("ws_one", catalog("Renamed Luna"));
  expect((await fake.read("ses_bound", { summary: true })).model).toEqual({ providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: "Renamed Luna", providerName: "Fixture Managed" });
  for (const summary of [false, true]) {
    expect((await fake.read("ses_stale", { summary })).model).toEqual({ providerId: PROVIDER, modelId: STALE_MODEL, variant: "low" });
    expect((await fake.read("ses_unbound", { summary })).model).toBeNull();
  }
  expect(JSON.stringify([...fake.sessions.entries()])).toBe(before);
  expect(fake.writes()).toEqual([]);
  expect(fake.requests.some((request) => request.path.includes("/ws_two/"))).toBe(false);
  evidence.recordAssertionEvidence("Read labels decorate rather than migrate persisted model bindings", "Normal and summary reads returned current labels; removed ids and effort survived verbatim without substitute labels, unbound stayed null, and no model record or other workspace was written.", fake.writes().length === 0 && JSON.stringify([...fake.sessions.entries()]) === before);
});

modelCase("catalog outages preserve readable raw bindings and fail discovery explicitly", async () => {
  const fake = await witness();
  fake.unavailable.add("ws_one");
  expect((await fake.read("ses_bound")).model).toEqual({ providerId: PROVIDER, modelId: MODEL, variant: "high" });
  expect(record(JSON.parse(await fake.query("models.list", { workspaceId: "ws_one" })))).toMatchObject({ ok: false, error: "Fixture catalog unavailable" });
  expect(fake.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Catalog failure is not an invented model", "Session metadata remained readable with ids and effort only, and discovery failed explicitly, without any write.", fake.writes().length === 0);
});

modelCase("session.read sanitizes an error-only latest assistant and clears it after success", async () => {
  const fake = await witness();
  const messages = [
    message("msg_user", "user", "Fixture request"),
    message("msg_old", "assistant", "Earlier success"),
    message("msg_error", "assistant", "", { type: "api", message: SECRET, data: { message: SECRET, statusCode: 401, responseBody: SECRET, responseHeaders: { authorization: SECRET } } }),
  ];
  fake.transcripts.set("ses_bound", messages);
  for (const summary of [false, true]) {
    const read = await fake.read("ses_bound", { summary });
    expect(read.lastError).toEqual({ code: expect.any(String), message: expect.any(String) });
    expect(JSON.stringify(read)).not.toContain(SECRET);
    if (summary) expect(read.lastAssistant).toMatchObject({ id: "msg_old", text: "Earlier success" });
    else expect(records(read.messages).map((entry) => entry.id)).toEqual(["msg_user", "msg_old"]);
  }
  messages.push(message("msg_success", "assistant", "Recovered"));
  for (const summary of [false, true]) {
    const recovered = await fake.read("ses_bound", { summary });
    expect(recovered.lastError).toBeNull();
    expect(JSON.stringify(recovered)).not.toContain(SECRET);
  }
  expect(fake.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Latest assistant error is sanitized and never sticky after success", "An error-only latest assistant surfaced a code and message despite an older readable success; raw provider detail never escaped in either read mode, and later success cleared lastError without writes.", fake.writes().length === 0);
});

modelCase("lastError reflects the loaded transcript window, not a fabricated full-history assertion", async () => {
  const fake = await witness();
  fake.transcripts.set("ses_bound", [
    message("msg_first", "user", "Start"),
    message("msg_error", "assistant", "", { type: "api", message: SECRET }),
    message("msg_latest", "user", "Retry"),
  ]);
  expect((await fake.read("ses_bound", { count: 1 })).lastError).toBeNull();
  expect((await fake.read("ses_bound", { count: 2 })).lastError).toEqual({ code: expect.any(String), message: expect.any(String) });
  const head = await fake.read("ses_bound", { from: "start", count: 1 });
  expect(head.lastError).toEqual({ code: expect.any(String), message: expect.any(String) });
  expect(records(head.messages).map((entry) => entry.id)).toEqual(["msg_first"]);
  expect(fake.requests.filter((request) => request.path.endsWith("/message")).map((request) => request.search)).toEqual(["?limit=1", "?limit=2", "?limit=200"]);
  expect(JSON.stringify(head)).not.toContain(SECRET);
  expect(fake.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Windowed reads do not claim errors outside loaded history", "A one-message tail omitted the earlier error, a two-message tail exposed it, and a from-start read inspected full history despite returning only the first readable message; no raw detail or writes escaped.", fake.writes().length === 0);
});

modelCase("renderer session inventory uses each workspace catalog without changing raw bindings", async () => {
  const state: ListControlSessionsState = {
    workspaces,
    sessionsByWorkspaceId: {
      ws_one: [
        { id: "ses_one", model: { providerID: PROVIDER, id: MODEL, variant: "high" } },
        { id: "ses_stale", model: { providerID: PROVIDER, id: STALE_MODEL, variant: "low" } },
        { id: "ses_unbound" },
      ],
      ws_two: [{ id: "ses_two", model: { providerID: PROVIDER, id: MODEL, variant: "default" } }],
    },
    modelCatalogByWorkspaceId: { ws_one: openworkCatalogModels(catalog()), ws_two: openworkCatalogModels(catalog("Workspace Two Luna")) },
    pinnedIds: [],
    statusFor: () => "idle",
  };
  const before = JSON.stringify(state.sessionsByWorkspaceId);
  const listed = listControlSessions({}, state);
  expect(listed.map((entry) => ({ id: entry.sessionId, model: entry.model }))).toEqual([
    { id: "ses_one", model: { providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: NAME, providerName: "Fixture Managed" } },
    { id: "ses_stale", model: { providerId: PROVIDER, modelId: STALE_MODEL, variant: "low" } },
    { id: "ses_unbound", model: null },
    { id: "ses_two", model: { providerId: PROVIDER, modelId: MODEL, variant: null, displayName: "Workspace Two Luna", providerName: "Fixture Managed" } },
  ]);
  expect(listControlSessions({ workspaceId: "ws_two" }, state)).toEqual([listed[3]]);
  expect(listControlSessions({}, { ...state, modelCatalogByWorkspaceId: {} }).map((entry) => entry.model)).toEqual([
    { providerId: PROVIDER, modelId: MODEL, variant: "high" },
    { providerId: PROVIDER, modelId: STALE_MODEL, variant: "low" },
    null,
    { providerId: PROVIDER, modelId: MODEL, variant: null },
  ]);
  expect(JSON.stringify(state.sessionsByWorkspaceId)).toBe(before);
  evidence.recordAssertionEvidence("Renderer inventory labels are scoped decorations, not model migration", "Identical opaque ids received different workspace labels; scoping excluded other sessions, missing catalogs preserved ids, stale bindings stayed stale, and input records did not mutate.", listed.length === 4 && JSON.stringify(state.sessionsByWorkspaceId) === before);
});

  expect(cases).toHaveLength(6);
  for (const { name, run } of cases) {
    try {
      await run();
    } catch (error) {
      throw new Error(`Case failed: ${name}`, { cause: error });
    } finally {
      await cleanupWitnesses();
    }
  }
});
