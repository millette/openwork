import { expect } from "vitest";
import { eventually, observeTranscript, readTranscriptMessages, spec } from "@openwork/testkit";
import {
  quotedDraft,
  quotedDraftChat,
  quotedDraftCommand,
  quotedDraftMarker,
  streamedMarkdown,
  streamedMarkdownMarker,
  streamedMarkdownReasoning,
} from "../worlds/chat.ts";
import {
  chatStreamContinuityWeb,
  streamedContinuityBullets,
  streamedContinuityChunks,
  streamedContinuityMarker,
  streamedContinuityPartialFifth,
  streamedContinuityPartialSeventh,
  streamedContinuityPartialThird,
  streamedContinuityPrompt,
} from "../worlds/chat-stream-continuity.ts";

const test = spec.world(streamedMarkdown, { timeout: 420_000 });
const prompt = `Write the streamed markdown answer. ${streamedMarkdownMarker}`;

const headingText = "Streamed answer heading";
const closingText = "Closing paragraph epsilon.";
// One sentinel per block of the answer; each must be on screen exactly once.
const blockSentinels = [
  headingText,
  "Opening paragraph with",
  "alpha list item",
  "beta list item",
  "gamma row",
  'const streamed = "delta";',
  closingText,
];
// Markdown syntax that must be rendered, never shown as text.
const rawSyntax = ["## Streamed", "**bold emphasis**", "`inline-code.ts`", "- alpha", "| gamma row", "```"];

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function expectSettledDocument(visibleText: string) {
  for (const sentinel of blockSentinels) expect(occurrences(visibleText, sentinel)).toBe(1);
  for (const syntax of rawSyntax) expect(visibleText).not.toContain(syntax);
}

test("sending clears the composer and shows one pending turn in existing and new conversations", async ({ world, user, probe, step }) => {
  for (const scenario of ["existing", "new"]) {
    if (scenario === "new") await user.click({ role: "button", label: "New session" });
    const text = `Keep this ${scenario} conversation message while submission is delayed.`;
    await user.type("composer", text);
    await world.holdNextSubmission();
    await step(`${scenario}: Send clears the input before server acceptance`, async () => {
      await user.click("Run task");
      await user.see("composer", { text: "", timeoutMs: 500 });
      await user.see({ text }, { timeoutMs: 500 });
      expect(await probe.eventually(() => world.submissionAttempts(), {
        within: 20_000, label: "held submission", until: (count) => count === 1,
      })).toBe(1);
      expect((await probe.composer()).draftText).toBe("");
      expect(occurrences(await probe.text(), text)).toBe(1);
    });
    await step(`${scenario}: failure retains the message without replacing newer typing`, async () => {
      await user.type("composer", "A newer draft");
      await world.rejectSubmission();
      await user.see({ text: /Your unsent message is saved/ });
      expect((await probe.composer()).draftText).toBe("A newer draft");
      expect(await world.submissionAttempts()).toBe(1);
      await user.type("composer", "", { replace: true });
      await user.click("Restore unsent message");
      await user.see("composer", { text });
      expect(await world.submissionAttempts()).toBe(1);
    });
  }
});

test("a streaming answer renders as markdown block by block and settles to the same document", async ({ world, user, probe, step }) => {
  const entries = [
    { role: "user", text: prompt } satisfies { role: "user"; text: string },
    ...blockSentinels.map((text): { role: "assistant"; text: string } => ({ role: "assistant", text })),
  ];
  await using transcript = await observeTranscript(probe, entries);
  await user.type("composer", prompt);
  await user.click("Run task");
  await user.see({ text: prompt }, { timeoutMs: 2_000 });

  await step("finished blocks render as markdown while later blocks are still arriving", async () => {
    await user.see({ text: headingText }, { timeoutMs: 90_000 });
    await user.notSee({ text: closingText });
    await user.notSee({ text: "## Streamed" });
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("live reasoning can be inspected before any reload while the answer is still streaming", async () => {
    const reasoningControl = { role: "button", label: /^(Thinking…|Thought)$/ } as const;
    await user.see(reasoningControl);
    await user.click(reasoningControl);
    await user.see({ text: streamedMarkdownReasoning });
    expect(occurrences(await probe.text(), streamedMarkdownReasoning)).toBe(1);
    await user.notSee({ text: closingText });
    await user.click(reasoningControl);
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("sent text and finished blocks stay visible before reloading the active stream", async () => {
    // The observer belongs to this document and must be verified before navigation.
    const continuity = await transcript.finish();
    expect(continuity).toMatchObject({ violations: [], stopped: false, frames: expect.any(Number) });
    expect(continuity.seen.slice(0, 2)).toEqual([true, true]);
    await user.notSee({ text: closingText });
    await user.reload();
  });
  await using reloadedTranscript = await observeTranscript(probe, entries);

  await step("the settled answer shows every block exactly once and no markdown syntax", async () => {
    await user.see({ text: closingText }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    expectSettledDocument(await probe.text());
    await user.see({ text: "alpha list item" });
    await user.see({ text: 'const streamed = "delta";' });
    await user.notSee({ text: /Something went wrong/ });
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("the settled reasoning is collapsed and can be inspected separately", async () => {
    await user.click({ role: "button", label: "Thought" });
    await user.see({ text: streamedMarkdownReasoning });
    expect(occurrences(await probe.text(), streamedMarkdownReasoning)).toBe(1);
    expectSettledDocument(await probe.text());
  });

  await step("sent text and streamed blocks never disappear or duplicate after reload", async () => {
    expect(await reloadedTranscript.finish()).toMatchObject({
      seen: [true, ...blockSentinels.map(() => true)],
      violations: [],
      stopped: false,
      frames: expect.any(Number),
    });
  });

  await step("a referenced workspace video has controls and plays only when requested", async () => {
    const ready = await eventually(() => world.videoState(), {
      within: 30_000, until: (state) => state?.ready === true,
    });
    expect(ready).toMatchObject({ controls: true, autoplay: false, paused: true, error: null });
    await world.videoState(true);
    const playing = await eventually(() => world.videoState(), {
      within: 5_000, until: (state) => (state?.time ?? 0) > 0,
    });
    if (!playing) throw new Error("Video disappeared during playback");
    expect(playing.time).toBeGreaterThan(0);
    expect(playing.error).toBeNull();
  });

  await step("history renders the same document after a reload", async () => {
    await user.reload();
    await user.see({ text: closingText }, { timeoutMs: 120_000 });
    expectSettledDocument(await probe.text());
    await user.see({ text: prompt });
    await user.see({ text: headingText });
    const video = await eventually(() => world.videoState(), {
      within: 30_000, until: (state) => state?.ready === true,
    });
    expect(video).toMatchObject({ controls: true, paused: true, autoplay: false, error: null });
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("reloaded reasoning stays collapsed until inspected separately", async () => {
    await user.click({ role: "button", label: "Thought" });
    await user.see({ text: streamedMarkdownReasoning });
    expect(occurrences(await probe.text(), streamedMarkdownReasoning)).toBe(1);
    expectSettledDocument(await probe.text());
  });
});

const quoteTest = spec.world(quotedDraftChat, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

quoteTest("a member copies a reply the answer quotes, with every bullet still on its own line", async ({ world, user, probe, step, evidence }) => {
  const quotePrompt = `Draft a launch update I can paste to the team. ${quotedDraftMarker}`;
  const draftLines = quotedDraft.split("\n").filter(Boolean);
  const bullets = draftLines.filter((line) => line.startsWith("•"));

  await step("given an answer that quotes a reply to send, followed by a command", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await user.type("composer", quotePrompt);
    await user.click("Run task");
    await user.see({ text: quotedDraftCommand }, { timeoutMs: 120_000 });
    const replies = await world.providerReplies();
    evidence.recordAssertionEvidence("The model answered once with a quoted reply",
      `${replies} model reply; it quotes ${draftLines.length} lines, ${bullets.length} of them "•" bullets, then a code block`, replies === 1);
    expect(replies).toBe(1);
    await user.screenshot();
  });

  await step("after: each line of the quoted reply sits on its own line, clear of the quote's edges", async () => {
    // innerText keeps a line break only where the page actually breaks the line.
    const shownLines = (await probe.text()).includes(quotedDraft);
    const quote = (await probe.dom("blockquote")).elements[0];
    const paragraphs = (await probe.dom("blockquote p")).elements;
    const first = paragraphs[0];
    const last = paragraphs.at(-1);
    if (!quote || !first || !last) throw new Error("The answer has no quoted paragraphs.");
    const topGap = Math.round(first.rect.top - quote.rect.top);
    const bottomGap = Math.round(quote.rect.bottom - last.rect.bottom);
    const ok = shownLines && topGap >= 8 && bottomGap >= 8;
    evidence.recordAssertionEvidence("The quoted reply keeps its lines and clears its edges",
      `${draftLines.length} lines shown one per line: ${shownLines}; text starts ${topGap}px below the quote's top and ends ${bottomGap}px above its bottom`, ok);
    expect(shownLines).toBe(true);
    expect(topGap).toBeGreaterThanOrEqual(8);
    expect(bottomGap).toBeGreaterThanOrEqual(8);
    await user.screenshot();
  });

  await step("after: Copy quote puts the exact reply on the clipboard, bullets and line breaks included", async () => {
    await user.click({ role: "button", label: "Copy quote" });
    await user.see({ role: "button", label: "Quote copied" });
    const copied = await probe.eventually(() => world.readClipboard(), {
      within: 5_000,
      label: "quoted reply on the clipboard",
      until: (value) => value === quotedDraft,
    });
    evidence.recordAssertionEvidence("Copy quote copies the reply as written",
      `clipboard holds ${copied.split("\n").length} lines including ${bullets.length} "•" bullets and no ">" quote markers`, copied === quotedDraft);
    expect(copied).toBe(quotedDraft);
    await user.screenshot();
  });

  await step("the code block below keeps its own copy button and copies only its command", async () => {
    await user.click({ role: "button", label: "Copy code block" });
    await user.see({ role: "button", label: "Code block copied" });
    const copied = await probe.eventually(() => world.readClipboard(), {
      within: 5_000,
      label: "command on the clipboard",
      until: (value) => value === quotedDraftCommand,
    });
    evidence.recordAssertionEvidence("The code block still copies only its code",
      `clipboard holds "${copied}"; none of the quoted reply`, copied === quotedDraftCommand);
    expect(copied).toBe(quotedDraftCommand);
    await user.screenshot();
  });
});

const continuityTest = spec.world(chatStreamContinuityWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});
const normalizedLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
const partialThirdPrefix = [streamedContinuityBullets[0], streamedContinuityBullets[1], streamedContinuityPartialThird].join("\n");
const partialFifthPrefix = [...streamedContinuityBullets.slice(0, 4), streamedContinuityPartialFifth].join("\n");
const partialSeventhPrefix = [...streamedContinuityBullets.slice(0, 6), streamedContinuityPartialSeventh].join("\n");
const completeContinuityAnswer = streamedContinuityBullets.join("\n");

continuityTest("CONT-01 restores the exact cumulative prefix while one answer streams across conversation switches", async ({ world, user, probe, step, evidence }) => {
  const assistantText = async () => {
    const messages = await readTranscriptMessages(probe, "assistant");
    return { messages, text: normalizedLines(messages.join("\n")) };
  };
  const expectOneUserAdmission = async () => {
    const messages = await readTranscriptMessages(probe, "user");
    expect(messages).toHaveLength(1);
    expect(occurrences(messages[0] ?? "", streamedContinuityPrompt)).toBe(1);
  };
  const select = async (target: { sessionId: string; title: string }) => {
    await user.click({ text: target.title });
    return probe.eventually(() => world.continuity.surfaceState("primary"), {
      within: 15_000,
      intervalMs: 100,
      label: `visible conversation ${target.title}`,
      until: (state) => state.sessionId === target.sessionId,
    });
  };
  const waitForEngineHttpPrefix = (prefix: string, forbidden: string) => probe.eventually(
    () => world.engineHttpEvents(),
    {
      within: 15_000,
      intervalMs: 25,
      label: "real app engine HTTP stream received the exact released prefix",
      until: (state) => state.streams > 0 && state.text.includes(prefix) && !state.text.includes(forbidden),
    },
  );
  const promptPosts = async () => (await world.engineHttpEvents()).promptPosts[world.session.sessionId] ?? 0;
  const observeWarmReturn = async (
    exact: string,
    forbidden: string,
    options: { allowInitialCatchup?: boolean; required?: string[] } = {},
  ) => {
    await using observer = await world.continuity.observeSurface({
      sessionId: world.session.sessionId,
      pane: "primary",
      role: "assistant",
      exact,
      allowInitialCatchup: options.allowInitialCatchup,
      required: options.required,
      forbidden: [forbidden],
    });
    await user.click({ text: world.session.title });
    const state = await probe.eventually(() => observer.read(), {
      within: 1_500,
      intervalMs: 25,
      label: "exact cached prefix on warm conversation return",
      until: (value) => value.satisfiedAtMs !== null,
    });
    expect(state.text).toBe(exact);
    if (state.violations.length > 0) {
      evidence.recordAssertionEvidence(
        "Warm return transition diagnostics",
        JSON.stringify({ firstViolation: state.firstViolation, transitionSamples: state.transitionSamples }),
        false,
      );
    }
    expect(state.violations).toEqual([]);
    if (state.satisfiedAtMs === null) throw new Error("Warm return never rendered the authoritative prefix.");
    expect(state.actionCaptured).toBe(true);
    if (state.satisfiedAfterActionMs === null) throw new Error("Warm return did not retain the sidebar click timestamp.");
    expect(state.satisfiedAfterActionMs).toBeLessThan(500);
    const retained = await probe.eventually(() => observer.read(), {
      within: 500,
      intervalMs: 16,
      label: "exact returned prefix remains stable after catch-up",
      until: (value) => value.frames >= state.frames + 2,
    });
    expect(retained.text).toBe(exact);
    expect(retained.violations).toEqual([]);
    return state.satisfiedAfterActionMs;
  };
  for (const bullet of streamedContinuityBullets) expect(streamedContinuityPrompt).not.toContain(bullet);

  await step("the engine runs in the real headless app-web world", async () => {
    const facts = await world.runtimeFacts();
    evidence.recordJsonArtifact("CONT-01 runtime placement", facts);
    expect(facts.surface).toBe("web");
    expect(facts.requestedPlacement).toBe(facts.resolvedPlacement);
    expect(facts.actualHostKind).toBe(facts.resolvedPlacement);
    if (facts.actualHostKind === "daytona") expect(facts.actualSandboxId).toMatch(/^.+$/);
    else expect(facts.actualSandboxId).toBeNull();
    expect(facts.healthStatus).toBe(200);
    expect(facts.engineStatus).toBe(200);
    expect(facts.nativeStatus).toBe(200);
    expect(facts.tokenPresent).toBe(true);
    expect(facts.serverPortPresent).toBe(true);
    expect(facts.engineRunning).toBe(true);
    expect(facts.syntheticModelInNativeResponse).toBe(true);
    expect(facts.electronBridge).toBe(false);
    expect(facts.origin).toBe(facts.expectedOrigin);
    expect(facts.browser).toMatch(/HeadlessChrome\//);
    if (facts.actualHostKind === "daytona") expect(facts.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    else if (facts.actualSourceSha !== null) expect(facts.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    evidence.recordAssertionEvidence(
      "Continuity headless app-web and engine fixture are real",
      `${facts.surface}; requested/resolved/actual placement=${facts.requestedPlacement}/${facts.resolvedPlacement}/${facts.actualHostKind}; sandbox=${facts.actualSandboxId ?? "none"}; ${facts.browser}; native ${facts.nativeStatus}; no Electron bridge=${String(!facts.electronBridge)}`,
      true,
    );
  });

  await step("one real send admits once and renders only the initially released first bullet", async () => {
    await using transcript = await observeTranscript(probe, [{ role: "user", text: streamedContinuityPrompt }]);
    await user.type("composer", streamedContinuityPrompt);
    await user.click("Run task");
    await user.see({ text: streamedContinuityPrompt }, { timeoutMs: 2_000 });
    const gate = await probe.eventually(() => world.replyState(), {
      within: 90_000,
      intervalMs: 100,
      label: "provider held after the first exact chunk",
      until: (state) => state.deliveredChunks === 1,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks[0]);
    const rendered = await probe.eventually(assistantText, {
      within: 5_000,
      intervalMs: 50,
      label: "only bullet one is rendered",
      until: (value) => value.messages.length === 1 && value.text === streamedContinuityBullets[0],
    });
    expect(rendered.text).toBe(streamedContinuityBullets[0]);
    await expectOneUserAdmission();
    expect(await promptPosts()).toBe(1);
    expect(await world.providerFinalRequests()).toHaveLength(1);
    const admission = await transcript.finish();
    evidence.recordJsonArtifact("CONT-01 submitted user text continuity", admission);
    expect(admission).toMatchObject({ seen: [true], violations: [], stopped: false });
  });

  await step("B remains empty while bullet two and partial bullet three advance only in A", async () => {
    await select(world.neighbor);
    expect(await readTranscriptMessages(probe, "user")).toEqual([]);
    expect(await readTranscriptMessages(probe, "assistant")).toEqual([]);
    await world.releaseReply(2);
    const gate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "provider released bullet two and partial bullet three",
      until: (state) => state.deliveredChunks === 3,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks.slice(0, 3).join(""));
    await waitForEngineHttpPrefix(streamedContinuityPartialThird, streamedContinuityBullets[2]);
    expect(await promptPosts()).toBe(1);
    expect(await world.providerFinalRequests()).toHaveLength(1);
    const b = await world.readNative(world.neighbor.sessionId);
    expect(b.status).toBe(200);
    expect(b.text).not.toContain(streamedContinuityPrompt);
    for (const bullet of streamedContinuityBullets) expect(b.text).not.toContain(bullet);
  });

  const firstReturnMs = await step("returning while bullet three is partial commits the exact full prefix in under 500ms", async () => {
    return observeWarmReturn(partialThirdPrefix, streamedContinuityBullets[2], {
      allowInitialCatchup: true,
      required: [streamedContinuityBullets[0]],
    });
  });

  await step("the same answer completes bullet three, then reaches a second mid-part switch", async () => {
    await world.releaseReply();
    const firstCumulativeGate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "engine provider HTTP stream reached partial bullet five",
      until: (state) => state.deliveredChunks === 4,
    });
    expect(firstCumulativeGate.prefix).toBe(streamedContinuityChunks.slice(0, 4).join(""));
    await waitForEngineHttpPrefix(streamedContinuityPartialFifth, streamedContinuityBullets[4]);
    const rendered = await probe.eventually(assistantText, {
      within: 5_000,
      intervalMs: 50,
      label: "cumulative answer through partial bullet five",
      until: (value) => value.messages.length === 1 && value.text === partialFifthPrefix,
    });
    expect(rendered.text).toBe(partialFifthPrefix);
    await select(world.neighbor);
    expect(await readTranscriptMessages(probe, "assistant")).toEqual([]);
    await world.releaseReply();
    const gate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "second offscreen cumulative release",
      until: (state) => state.deliveredChunks === 5,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks.slice(0, 5).join(""));
    await waitForEngineHttpPrefix(streamedContinuityPartialSeventh, streamedContinuityBullets[6]);
    expect(await promptPosts()).toBe(1);
    expect(await world.providerFinalRequests()).toHaveLength(1);
  });

  const secondReturnMs = await step("a repeated middle-of-part return restores the newer cumulative prefix without replay", async () => {
    return observeWarmReturn(partialSeventhPrefix, streamedContinuityBullets[6], {
      allowInitialCatchup: true,
      required: [...streamedContinuityBullets.slice(0, 4), streamedContinuityPartialFifth],
    });
  });

  await step("the held answer finishes all ten unique bullets exactly once and leaves B unmodified", async () => {
    await world.releaseReply();
    await user.see({ text: streamedContinuityBullets[9] }, { timeoutMs: 30_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const gate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "provider completed the exact controlled reply",
      until: (state) => state.complete,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks.join(""));
    const assistant = await assistantText();
    expect(assistant.messages).toHaveLength(1);
    expect(assistant.text).toBe(completeContinuityAnswer);
    for (const bullet of streamedContinuityBullets) expect(occurrences(assistant.text, bullet)).toBe(1);
    await expectOneUserAdmission();
    expect(await promptPosts()).toBe(1);
    const providerRequests = await world.providerFinalRequests();
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({ promptMarker: streamedContinuityMarker, kind: "final" });
    const a = await world.readNative(world.session.sessionId);
    expect(a.status).toBe(200);
    expect(occurrences(a.text, streamedContinuityPrompt)).toBe(1);
    for (const bullet of streamedContinuityBullets) expect(occurrences(a.text, bullet)).toBe(1);
    const b = await world.readNative(world.neighbor.sessionId);
    expect(b.status).toBe(200);
    expect(b.text).not.toContain(streamedContinuityPrompt);
    for (const bullet of streamedContinuityBullets) expect(b.text).not.toContain(bullet);
  });

  await step("reload recovers the exact completed answer without another admission", async () => {
    await user.reload();
    await user.see({ text: streamedContinuityBullets[9] }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const assistant = await assistantText();
    expect(assistant.messages).toHaveLength(1);
    expect(assistant.text).toBe(completeContinuityAnswer);
    await expectOneUserAdmission();
    expect(await promptPosts()).toBe(0);
    expect(await world.providerFinalRequests()).toHaveLength(1);
    const b = await world.readNative(world.neighbor.sessionId);
    expect(b.text).not.toContain(streamedContinuityPrompt);
    evidence.recordAssertionEvidence(
      "CONT-01 exact held-prefix continuity",
      `Exact 10-bullet answer once; click-to-prefix ${Math.round(firstReturnMs)}ms/${Math.round(secondReturnMs)}ms; one native prompt POST before reload and zero after; one final provider request; B empty.`,
      true,
    );
  });
});
