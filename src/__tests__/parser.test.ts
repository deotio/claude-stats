import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseSessionFile, hashFirstKb } from "../parser/session.js";
import os from "os";
import path from "path";
import fs from "fs";

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpFile(): string {
  return path.join(os.tmpdir(), `cs-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function writeLines(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

const BASE_SESSION = "sess-xyz";
const BASE_VERSION = "2.1.70";

function userEntry(isMeta = false) {
  return {
    type: "user",
    sessionId: BASE_SESSION,
    version: BASE_VERSION,
    timestamp: 1_000_000,
    uuid: `u-${Math.random()}`,
    isMeta,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  };
}

function assistantEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    sessionId: BASE_SESSION,
    version: BASE_VERSION,
    timestamp: 1_001_000,
    uuid: `a-${Math.random()}`,
    entrypoint: "claude-vscode",
    gitBranch: "main",
    permissionMode: "default",
    message: {
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 80,
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
      },
    },
    ...overrides,
  };
}

// ── hashFirstKb ───────────────────────────────────────────────────────────────

describe("hashFirstKb", () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpFile(); });
  afterEach(() => { try { fs.unlinkSync(filePath); } catch { /* ok */ } });

  it("returns a 64-char hex string", () => {
    fs.writeFileSync(filePath, "hello");
    expect(hashFirstKb(filePath)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hashes for different content", () => {
    fs.writeFileSync(filePath, "aaa");
    const h1 = hashFirstKb(filePath);
    fs.writeFileSync(filePath, "bbb");
    const h2 = hashFirstKb(filePath);
    expect(h1).not.toBe(h2);
  });

  it("is stable for the same content", () => {
    fs.writeFileSync(filePath, "stable content");
    expect(hashFirstKb(filePath)).toBe(hashFirstKb(filePath));
  });

  it("handles files smaller than 1KB", () => {
    fs.writeFileSync(filePath, "tiny");
    expect(() => hashFirstKb(filePath)).not.toThrow();
  });

  it("handles empty files", () => {
    fs.writeFileSync(filePath, "");
    expect(() => hashFirstKb(filePath)).not.toThrow();
  });
});

// ── parseSessionFile ──────────────────────────────────────────────────────────

describe("parseSessionFile", () => {
  let filePath: string;

  beforeEach(() => { filePath = tmpFile(); });
  afterEach(() => { try { fs.unlinkSync(filePath); } catch { /* ok */ } });

  it("returns null session for empty file", async () => {
    fs.writeFileSync(filePath, "");
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session).toBeNull();
    expect(result.messages).toHaveLength(0);
  });

  it("parses a minimal session with one user and one assistant message", async () => {
    writeLines(filePath, [userEntry(), assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe(BASE_SESSION);
    expect(result.session!.promptCount).toBe(1);
    expect(result.session!.assistantMessageCount).toBe(1);
  });

  it("accumulates token counts from multiple assistant messages", async () => {
    writeLines(filePath, [assistantEntry(), assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.inputTokens).toBe(200);
    expect(result.session!.outputTokens).toBe(100);
    expect(result.session!.cacheCreationTokens).toBe(40);
    expect(result.session!.cacheReadTokens).toBe(160);
  });

  it("counts web search and fetch requests", async () => {
    writeLines(filePath, [assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.webSearchRequests).toBe(1);
    expect(result.session!.webFetchRequests).toBe(2);
  });

  it("does not count meta user messages as prompts", async () => {
    writeLines(filePath, [userEntry(false), userEntry(true)]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.promptCount).toBe(1);
  });

  it("marks session as interactive when queue-operation is present", async () => {
    const queueEntry = { type: "queue-operation", operation: "enqueue", sessionId: BASE_SESSION, timestamp: 999_000 };
    writeLines(filePath, [queueEntry, userEntry(), assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.isInteractive).toBe(true);
  });

  it("marks session as non-interactive without queue-operation", async () => {
    writeLines(filePath, [userEntry(), assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.isInteractive).toBe(false);
  });

  it("extracts tool use counts from assistant content blocks", async () => {
    const entry = assistantEntry({});
    (entry as Record<string, unknown>).message = {
      ...((entry as Record<string, unknown>).message as Record<string, unknown>),
      content: [
        { type: "tool_use", name: "Read", id: "t1", input: {} },
        { type: "tool_use", name: "Read", id: "t2", input: {} },
        { type: "tool_use", name: "Edit", id: "t3", input: {} },
      ],
    };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    const readCount = result.session!.toolUseCounts.find(t => t.name === "Read")?.count;
    const editCount = result.session!.toolUseCounts.find(t => t.name === "Edit")?.count;
    expect(readCount).toBe(2);
    expect(editCount).toBe(1);
  });

  it("collects distinct models used", async () => {
    const e1 = assistantEntry();
    const e2 = {
      ...assistantEntry(),
      uuid: "a-other",
      message: { ...assistantEntry().message, model: "claude-sonnet-4-6" },
    };
    writeLines(filePath, [e1, e2]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.models).toContain("claude-opus-4-6");
    expect(result.session!.models).toContain("claude-sonnet-4-6");
  });

  it("records firstTimestamp and lastTimestamp correctly", async () => {
    const e1 = { ...userEntry(), timestamp: 1_000 };
    const e2 = { ...assistantEntry(), timestamp: 5_000 };
    writeLines(filePath, [e1, e2]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.firstTimestamp).toBe(1_000);
    expect(result.session!.lastTimestamp).toBe(5_000);
  });

  it("captures version, entrypoint, gitBranch, permissionMode from first matching entry", async () => {
    writeLines(filePath, [assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.claudeVersion).toBe(BASE_VERSION);
    expect(result.session!.entrypoint).toBe("claude-vscode");
    expect(result.session!.gitBranch).toBe("main");
    expect(result.session!.permissionMode).toBe("default");
  });

  it("skips mid-file malformed JSON and records it as an error", async () => {
    const lines = [
      JSON.stringify(userEntry()),
      "not valid json at all {{{",
      JSON.stringify(assistantEntry()),
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, lines);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.errors).toHaveLength(1);
    expect(result.session!.assistantMessageCount).toBe(1); // still parsed the good lines
  });

  it("discards a partial last line without recording as an error", async () => {
    const good = JSON.stringify(assistantEntry());
    const partial = '{"type":"assistant","sessionId":"' + BASE_SESSION; // truncated
    fs.writeFileSync(filePath, good + "\n" + partial);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.errors).toHaveLength(0); // partial last line is silently discarded
    expect(result.session!.assistantMessageCount).toBe(1);
  });

  it("stores per-message records for assistant messages with uuid", async () => {
    const entry = { ...assistantEntry(), uuid: "known-uuid" };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.uuid).toBe("known-uuid");
    expect(result.messages[0]!.inputTokens).toBe(100);
  });

  it("skips per-message record if uuid is missing", async () => {
    const entry = assistantEntry();
    delete (entry as Record<string, unknown>).uuid;
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.messages).toHaveLength(0);
  });

  it("returns lastGoodOffset greater than startOffset after processing lines", async () => {
    writeLines(filePath, [userEntry(), assistantEntry()]);
    const result = await parseSessionFile(filePath, "/proj", 0);
    expect(result.lastGoodOffset).toBeGreaterThan(0);
  });

  it("handles entries with no timestamp gracefully", async () => {
    const entry: Record<string, unknown> = { type: "assistant", sessionId: BASE_SESSION, uuid: "u1" };
    // no timestamp field
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.firstTimestamp).toBeNull();
  });

  it("handles content as a string instead of array", async () => {
    const entry = assistantEntry();
    (entry as Record<string, unknown>).message = {
      ...((entry as Record<string, unknown>).message as Record<string, unknown>),
      content: "some text string",
    };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    // Should not throw; tool use counts will be empty
    expect(result.session!.toolUseCounts).toHaveLength(0);
  });

  it("starts reading from a non-zero offset", async () => {
    // Write two entries; the first is a user entry we want to skip
    const firstLine = JSON.stringify(userEntry()) + "\n";
    const secondLine = JSON.stringify(assistantEntry()) + "\n";
    fs.writeFileSync(filePath, firstLine + secondLine);
    const offset = Buffer.byteLength(firstLine, "utf8");
    const result = await parseSessionFile(filePath, "/proj", offset);
    expect(result.session!.promptCount).toBe(0); // user entry skipped
    expect(result.session!.assistantMessageCount).toBe(1);
  });

  it("counts thinking blocks in assistant message", async () => {
    const entry = assistantEntry({});
    (entry as Record<string, unknown>).message = {
      ...((entry as Record<string, unknown>).message as Record<string, unknown>),
      content: [
        { type: "thinking", thinking: "Let me think about this..." },
        { type: "text", text: "Here is my answer." },
      ],
    };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.thinkingBlocks).toBe(1);
    expect(result.session!.thinkingBlocks).toBe(1);
  });

  it("counts multiple thinking blocks in a single message", async () => {
    const entry = assistantEntry({});
    (entry as Record<string, unknown>).message = {
      ...((entry as Record<string, unknown>).message as Record<string, unknown>),
      content: [
        { type: "thinking", thinking: "First thought..." },
        { type: "text", text: "Intermediate response." },
        { type: "thinking", thinking: "Second thought..." },
        { type: "text", text: "Final answer." },
      ],
    };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.messages[0]!.thinkingBlocks).toBe(2);
    expect(result.session!.thinkingBlocks).toBe(2);
  });

  it("reports thinkingBlocks = 0 when no thinking blocks present", async () => {
    const entry = assistantEntry({});
    (entry as Record<string, unknown>).message = {
      ...((entry as Record<string, unknown>).message as Record<string, unknown>),
      content: [{ type: "text", text: "Just text." }],
    };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.messages[0]!.thinkingBlocks).toBe(0);
    expect(result.session!.thinkingBlocks).toBe(0);
  });

  it("populates per-message tools array from tool_use content blocks", async () => {
    const entry = assistantEntry({});
    (entry as Record<string, unknown>).message = {
      ...((entry as Record<string, unknown>).message as Record<string, unknown>),
      content: [
        { type: "tool_use", name: "Read", id: "t1", input: {} },
        { type: "tool_use", name: "Edit", id: "t2", input: {} },
        { type: "tool_use", name: "Read", id: "t3", input: {} },
      ],
    };
    writeLines(filePath, [entry]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.messages[0]!.tools).toEqual(["Read", "Edit", "Read"]);
  });

  it("accumulates thinkingBlocks across multiple messages at session level", async () => {
    const e1 = assistantEntry({});
    (e1 as Record<string, unknown>).message = {
      ...((e1 as Record<string, unknown>).message as Record<string, unknown>),
      content: [
        { type: "thinking", thinking: "Think 1" },
        { type: "text", text: "Response 1" },
      ],
    };
    const e2 = assistantEntry({});
    (e2 as Record<string, unknown>).message = {
      ...((e2 as Record<string, unknown>).message as Record<string, unknown>),
      content: [
        { type: "thinking", thinking: "Think 2" },
        { type: "thinking", thinking: "Think 3" },
        { type: "text", text: "Response 2" },
      ],
    };
    writeLines(filePath, [e1, e2]);
    const result = await parseSessionFile(filePath, "/proj");
    expect(result.session!.thinkingBlocks).toBe(3);
    expect(result.messages[0]!.thinkingBlocks).toBe(1);
    expect(result.messages[1]!.thinkingBlocks).toBe(2);
  });
});
