import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  COMPUTER, FINAL_ANSWER, STEER_PROMPT, STEERED_ANSWER, TASK_PROMPT, TASK_TITLE, WORKSPACE_ID,
  object, records, remoteSessionSubagents, string,
} from "../worlds/remote-session-subagents.ts";

const test = spec.world(remoteSessionSubagents, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const SESSION_ID = "ses_syntheticreleasetask";
const ROW = "[data-remote-thread]";

test("a member follows, answers and steers a task their agent started on another computer, like a sub-agent", async ({ world, user, probe, step, evidence }) => {
  let commandId = "";
  // Each row's two lines: the task and where it runs, then what it is doing.
  const rows = async () => {
    const lines = (await probe.dom(`${ROW} > button > span`)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
    return Array.from({ length: Math.ceil(lines.length / 2) }, (_, index) => lines.slice(index * 2, index * 2 + 2).join(" / "));
  };
  const rowIn = async (state: string) => (await probe.dom(`${ROW}[data-remote-thread-state="${state}"]`)).elements.length;
  const nextRequest = async (action: string) => {
    const items = await probe.eventually(() => world.work(), {
      within: 45_000, intervalMs: 250, label: `the build machine receives the chat's ${action} request`,
      until: (found) => found.some((item) => item.kind === "remote_session_request"),
    });
    const requestId = string(items.find((item) => item.kind === "remote_session_request")?.requestId);
    const claimed = await world.claimRequest(requestId);
    expect(claimed.status).toBe(200);
    const assignment = object(object(claimed.body).assignment);
    expect(assignment.action).toBe(action);
    return { requestId, assignment };
  };

  await step("before: the agent starts the summary on the build machine and the chat shows only a tool call", async () => {
    await user.type("composer", world.ask);
    await user.click("Run task");
    await user.see({ text: "The summary is running on your build machine." }, { timeoutMs: 90_000 });
    const queued = await probe.eventually(() => world.work(), {
      within: 30_000, intervalMs: 250, label: "the build machine sees the queued task",
      until: (items) => items.some((item) => item.kind === "remote_session_create"),
    });
    commandId = string(queued.find((item) => item.kind === "remote_session_create")?.commandId);
    const shown = await rows();
    evidence.recordAssertionEvidence(
      "With the feature off, a started task is a plain tool call",
      `Den queued ${commandId} for ${COMPUTER}; task rows in the chat: ${shown.length}`,
      shown.length === 0,
    );
    expect(shown).toEqual([]);
    await user.screenshot();
  });

  await step("after: with the feature on, the task reads as a sub-agent waiting for the build machine", async () => {
    await world.turnFeatureOn();
    await user.reload();
    await user.see({ text: `Waiting for ${COMPUTER} to start it` }, { timeoutMs: 60_000 });
    const [row = ""] = await rows();
    evidence.recordAssertionEvidence("The row names the task and where it runs", `row: "${row}"`, row.includes(TASK_TITLE) && row.includes(COMPUTER));
    expect(row).toContain(TASK_TITLE);
    expect(row).toContain(COMPUTER);
    await user.screenshot();
  });

  await step("when the build machine starts it, the row says it is working", async () => {
    expect((await world.claim(commandId)).status).toBe(200);
    expect((await world.deliver(commandId, SESSION_ID)).status).toBe(200);
    expect((await world.report(commandId, { status: "running", messageCount: 1 })).status).toBe(200);
    await user.see({ text: /^Working/ }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("Den's receipt drives the row", `claimed, delivered ${SESSION_ID} in ${WORKSPACE_ID}, reported running; rows working: ${await rowIn("running")}`, (await rowIn("running")) === 1);
  });

  await step("while nothing changes, the chat waits on Den instead of asking again and again", async () => {
    const since = await world.denLog();
    // Thirty quiet seconds: the runner reports nothing new.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await user.see({ text: /^Working/ });
    const calls = await world.statusCalls(since);
    const waited = calls.filter((call) => call.durationMs >= 15_000).length;
    evidence.recordAssertionEvidence(
      "One waiting status call at a time, not a poll",
      `${calls.length} status calls in 30 s (${calls.map((call) => `${Math.round(call.durationMs / 1000)}s`).join(", ")}); ${waited} held by Den for a change`,
      calls.length <= 3 && waited >= 1,
    );
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(waited).toBeGreaterThanOrEqual(1);
  });

  await step("when the task asks a question, the row and the chat's sidebar entry say it needs the person", async () => {
    expect((await world.report(commandId, { status: "waiting", waitingFor: "question", messageCount: 2 })).status).toBe(200);
    await user.see({ text: `Waiting for your answer on ${COMPUTER}` }, { timeoutMs: 30_000 });
    await user.see({ label: new RegExp(`Waiting for your answer: ${TASK_TITLE}`) }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The question surfaces in the parent chat", `rows waiting: ${await rowIn("waiting")}; sidebar: "Release planning, Waiting for your answer: ${TASK_TITLE}"`, (await rowIn("waiting")) === 1);
    await user.screenshot();
  });

  await step("after: once answered on the build machine, the row shows the task's answer", async () => {
    expect((await world.report(commandId, { status: "idle", finalText: FINAL_ANSWER, messageCount: 4 })).status).toBe(200);
    await user.see({ text: /^Completed · Release 4\.2 ships three fixes/ }, { timeoutMs: 30_000 });
    const since = await world.denLog();
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const after = await world.statusCalls(since);
    evidence.recordAssertionEvidence("A finished task is no longer followed", `row: "${(await rows())[0] ?? ""}"; status calls in the 8 s after it finished: ${after.length}`, after.length === 0);
    expect(after).toEqual([]);
    await user.screenshot();
  });

  await step("after: the person opens the task, reads its conversation and steers it from the chat", async () => {
    await user.click({ role: "button", label: `${TASK_TITLE}. Open the task on ${COMPUTER}` });
    const read = await nextRequest("read");
    expect((await world.completeRequest(read.requestId, { action: "read", result: {
      title: TASK_TITLE, status: "idle", waitingFor: null, lastError: null, messageCount: 2, from: "end", nextCursor: null,
      messages: [
        { id: "msg_syntheticask", role: "user", createdAt: Date.now() - 60_000, text: TASK_PROMPT, truncated: false, toolCalls: [], error: null },
        { id: "msg_syntheticanswer", role: "assistant", createdAt: Date.now() - 30_000, text: FINAL_ANSWER, truncated: false, toolCalls: [], error: null },
      ],
    } })).status).toBe(200);
    // The answer is in the row's preview too; look for it in the opened conversation.
    const answer = await probe.eventually(async () => (await probe.dom('[data-remote-thread-panel] [data-remote-thread-message="assistant"]')).elements.map((element) => element.text), {
      within: 30_000, intervalMs: 250, label: "the panel shows the task's conversation",
      until: (texts) => texts.some((text) => text.includes(FINAL_ANSWER)),
    });
    expect(answer.join(" ")).toContain(FINAL_ANSWER);
    await user.type({ placeholder: "Follow up" }, STEER_PROMPT);
    await user.click({ role: "button", label: "Send" });
    const send = await nextRequest("send");
    const received = string(object(send.assignment.input).prompt);
    expect((await world.completeRequest(send.requestId, { action: "send", result: { messageId: string(object(send.assignment.input).messageId), alreadyPresent: false } })).status).toBe(200);
    await user.see({ text: /^Working/ }, { timeoutMs: 30_000 });
    expect((await world.report(commandId, { status: "idle", finalText: STEERED_ANSWER, messageCount: 4 })).status).toBe(200);
    await user.see({ text: /^Completed · Safer exports matter most/ }, { timeoutMs: 30_000 });
    // The open panel reads the conversation again because the task changed.
    const reread = await nextRequest("read");
    expect((await world.completeRequest(reread.requestId, { action: "read", result: {
      title: TASK_TITLE, status: "idle", waitingFor: null, lastError: null, messageCount: 4, from: "end", nextCursor: null,
      messages: [
        { id: "msg_syntheticask", role: "user", createdAt: Date.now() - 90_000, text: TASK_PROMPT, truncated: false, toolCalls: [], error: null },
        { id: "msg_syntheticanswer", role: "assistant", createdAt: Date.now() - 60_000, text: FINAL_ANSWER, truncated: false, toolCalls: [], error: null },
        { id: string(object(send.assignment.input).messageId), role: "user", createdAt: Date.now() - 20_000, text: received, truncated: false, toolCalls: [], error: null },
        { id: "msg_syntheticsteered", role: "assistant", createdAt: Date.now() - 5_000, text: STEERED_ANSWER, truncated: false,
          toolCalls: [{ id: "call_syntheticread", name: "read", status: "completed", input: null, output: null, error: null, truncated: false }], error: null },
      ],
    } })).status).toBe(200);
    const conversation = await probe.eventually(async () => (await probe.dom('[data-remote-thread-panel] [data-remote-thread-message="assistant"]')).elements.map((element) => element.text), {
      within: 30_000, intervalMs: 250, label: "the panel shows the steered answer",
      until: (texts) => texts.some((text) => text.includes(STEERED_ANSWER)),
    });
    evidence.recordAssertionEvidence(
      "The follow-up reaches the build machine word for word and its answer comes back",
      `the build machine received "${received}"; panel answers: ${conversation.length}; row now: "${(await rows())[0] ?? ""}"`,
      received === STEER_PROMPT && conversation.some((text) => text.includes(STEERED_ANSWER)),
    );
    expect(received).toBe(STEER_PROMPT);
    await user.screenshot();
  });

  await step("another member of the organization cannot see the owner's task", async () => {
    const result = await world.otherMemberStatus(commandId);
    const [thread] = records(object(result.body).threads);
    const error = thread ? object(thread.error) : {};
    await user.see({ text: /^Completed · Safer exports matter most/ });
    evidence.recordAssertionEvidence("Remote task status is private to its member", `other member: HTTP ${result.status}, state ${String(thread?.state)}, ${String(error.code)}; no title, computer or answer returned`, error.code === "unknown_command");
    expect(result.status).toBe(200);
    expect(thread).toMatchObject({ state: "error", title: null, preview: null, computerLabel: null, error: { code: "unknown_command" } });
  });
});
