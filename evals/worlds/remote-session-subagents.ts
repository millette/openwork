import { allocateFreePorts, browserScript } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";
import { object, records, remoteSessionGateway, string } from "./fixtures/remote-session-gateway.ts";

export { object, records, string } from "./fixtures/remote-session-gateway.ts";

export const COMPUTER = "Synthetic build machine";
export const WORKSPACE_ID = "synthetic_release_workspace";
export const TASK_TITLE = "Summarize the release notes";
export const TASK_PROMPT = "Summarize the release notes and list the fixes.";
export const FINAL_ANSWER = "Release 4.2 ships three fixes: faster sync, a calmer sidebar and safer exports.";
export const STEER_PROMPT = "Also say which fix matters most to people.";
export const STEERED_ANSWER = "Safer exports matter most: they stop half-written files.";
const ASK = "REMOTE-RELEASE-TASK Summarize the release notes on my build machine.";
const RUNNER_ID = "synthetic_build_runner";
const CAPABILITIES = ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"];

/**
 * A signed-in member's chat, real Den and its MCP, and one other computer: an
 * opted-in client registered with Den the way the OpenCode plugin does. The
 * world plays that computer's runner through Den's own runner routes (claim,
 * report progress, answer reads and follow-ups), so every status the chat
 * shows comes from Den's receipts. The model starts the task with the real
 * `remote-session:create`. The organization's `remoteSessionSubagents`
 * feature starts off.
 */
export async function remoteSessionSubagents(seed: Seed) {
  const engine = resolveEvalEngine();
  const [webPort] = await allocateFreePorts(1);
  if (!webPort) throw new Error("No app-web port available for the remote task world");
  const den = await seed.den({
    trustedOrigins: [`http://127.0.0.1:${webPort}`],
    org: { name: "Remote task proof", admin: { name: "Remote Task Owner" }, members: { other: { name: "Other Member" } } },
    mocks: { model: seed.mock() },
    env: { DEN_OPENWORK_WEB_ENABLED: "false" },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const other = den.members.other;
  if (!organizationId || !other) throw new Error("Could not resolve the remote task organization");
  const gateway = remoteSessionGateway({
    owner: { session: den.admin, organizationId },
    other: { session: other, organizationId },
  });

  const registered = await gateway.api("owner", "/v1/session-runners/token", "POST", {
    runnerId: RUNNER_ID, protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: CAPABILITIES,
    appVersion: "synthetic-remote-task-proof", platform: "linux", concurrency: 1,
  });
  if (registered.status !== 200) throw new Error(`Registering the build machine failed: HTTP ${registered.status}`);
  const runnerToken = string(object(registered.body).token);
  const runner = (path: string, method = "GET", body?: unknown) => gateway.api("owner", path, method, body, runnerToken);
  const inventory = await runner("/v1/session-runners/inventory", "PUT", {
    computer: { label: COMPUTER, platform: "linux", appVersion: "synthetic-remote-task-proof" },
    workspaces: [{ workspaceId: WORKSPACE_ID, name: "Release notes", active: true, engine: "v2", defaultModel: null, models: [] }],
  });
  if (inventory.status !== 200) throw new Error(`Reporting the build machine failed: HTTP ${inventory.status}`);

  // One online registered computer: Den picks it without a computerId.
  const create = { name: "remote-session:create", body: { target: "registered", title: TASK_TITLE, prompt: TASK_PROMPT } };
  const model = den.mocks.model;
  if (!model) throw new Error("Missing remote task model");
  const workloads = await fetch(`${model.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [{
      promptMarker: ASK, latestUserTurn: true, finalReply: "The summary is running on your build machine.",
      steps: [engine === "v2"
        ? { tool: "execute", arguments: { code: `return await tools["openwork-cloud"].execute_capability(${JSON.stringify(create)});` } }
        : { tool: "execute_capability", arguments: create }],
    }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!workloads.ok) throw new Error(`Arranging the model turn failed: HTTP ${workloads.status}`);

  const minted = await gateway.api("owner", "/v1/mcp/token", "POST", { scopes: ["mcp:read", "mcp:write"] });
  if (minted.status !== 200) throw new Error(`Minting the MCP token failed: HTTP ${minted.status}`);
  const workspacePath = seed.tmpPath("remote-session-subagents");
  const app = await seed.appWeb({ name: "remote-session-subagents", workspacePath, webPort, den: den.ref, engine });
  await seed.signIn(app, den.admin, "Remote task owner");
  const workspace = await seed.workspace(app, workspacePath);
  const providerId = "remote-task-model";
  const modelId = "remote-task-model";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Remote task model",
      options: { baseURL: `${model.url}/v1`, apiKey: "sk-remote-task-fixture" },
      models: { [modelId]: { name: "Remote task model", tool_call: true } },
    } },
  }, engine);
  // OpenWork Connect is attached the way the app does it; its name is reserved in workspace config.
  const connected = await seed.evalIn(app, browserScript(async (workspaceId, url, mcpToken) => {
    const port = localStorage.getItem("openwork.server.port");
    const credential = localStorage.getItem("openwork.server.token");
    const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`, {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ config: { type: "remote", url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${mcpToken}` } }, trigger: "remote-session-subagents-world" }),
    });
    return response.status;
  }, [workspace.workspaceId, `${den.ref.apiUrl}/mcp/agent`, string(object(minted.body).token)]), { awaitPromise: true, timeoutMs: 150_000 });
  if (connected !== 200) throw new Error(`Connecting OpenWork Connect failed: HTTP ${String(connected)}`);
  const session = await seed.session(app, { title: "Release planning" });

  /** Status calls Den served since a log snapshot, with how long each one waited. */
  async function statusCalls(since: string) {
    return (await den.apiLog()).slice(since.length).split("\n").flatMap((line) => {
      if (!line.includes("/v1/remote-sessions/status")) return [];
      try {
        const entry = object(JSON.parse(line));
        return entry.http_route === "/v1/remote-sessions/status" && typeof entry.duration_ms === "number"
          ? [{ status: Number(entry.http_status_code), durationMs: entry.duration_ms }]
          : [];
      } catch {
        return [];
      }
    });
  }

  return {
    app, den, session, engine, ask: ASK,
    /** The platform admin turns `remoteSessionSubagents` on for the member's organization, as /admin does. */
    turnFeatureOn: () => enableOrganizationCapabilities(seed, den.admin, { remoteSessionSubagents: true }, organizationId),
    /** The build machine's own view of its work: queued tasks and requests for it. */
    async work() {
      const result = await runner("/v1/session-runners/work");
      return result.status === 200 ? records(object(result.body).items) : [];
    },
    claim: (commandId: string) => runner(`/v1/remote-session-commands/${commandId}/claim`, "POST"),
    deliver: (commandId: string, sessionId: string) => runner(`/v1/remote-session-commands/${commandId}/complete`, "POST", { status: "delivered", sessionId, workspaceId: WORKSPACE_ID }),
    report: (commandId: string, body: Record<string, unknown>) => runner(`/v1/remote-session-commands/${commandId}/session`, "POST", { engine: "v2", observedAt: Date.now(), ...body }),
    claimRequest: (requestId: string) => runner(`/v1/remote-session-requests/${requestId}/claim`, "POST"),
    completeRequest: (requestId: string, outcome: Record<string, unknown>) => runner(`/v1/remote-session-requests/${requestId}/complete`, "POST", { status: "done", outcome }),
    /** Another member of the same organization asks Den about the owner's task. */
    otherMemberStatus: (commandId: string) => gateway.api("other", "/v1/remote-sessions/status", "POST", { threads: [{ commandId }] }),
    denLog: () => den.apiLog(),
    statusCalls,
  };
}
