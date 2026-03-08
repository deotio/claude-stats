/**
 * Session JSONL parser.
 *
 * Defensive parsing rules (see doc/analysis/08-resilience.md):
 * - Every field is optional — use optional chaining, never direct access
 * - Parse each line independently; one bad line must not abort the rest
 * - Discard the last line if it fails JSON parsing (likely a partial write)
 * - Use message uuid as the idempotency key for upserts
 */
import fs from "fs";
import crypto from "crypto";
import readline from "readline";
import type {
  RawSessionEntry,
  MessageRecord,
  SessionRecord,
  ToolUseCount,
  ParseError,
} from "../types.js";

export interface ParseResult {
  session: SessionRecord | null;
  messages: MessageRecord[];
  errors: ParseError[];
  /** byte offset after the last successfully parsed line */
  lastGoodOffset: number;
  /** SHA-256 hex of the first 1 KB of the file */
  firstKbHash: string;
}

/** Compute SHA-256 of the first `maxBytes` bytes of a file (default 1024). */
export function hashFirstKb(filePath: string, maxBytes: number = 1024): string {
  const buf = Buffer.alloc(maxBytes);
  const fd = fs.openSync(filePath, "r");
  const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
  fs.closeSync(fd);
  return crypto
    .createHash("sha256")
    .update(buf.subarray(0, bytesRead))
    .digest("hex");
}

/** Parse a session JSONL file from the given byte offset onward.
 *  Reads incrementally — only processes new lines since the last run. */
export async function parseSessionFile(
  filePath: string,
  projectPath: string,
  startOffset: number = 0
): Promise<ParseResult> {
  const firstKbHash = hashFirstKb(filePath);
  const messages: MessageRecord[] = [];
  const errors: ParseError[] = [];

  // Collect all raw lines from startOffset
  const lines: Array<{ raw: string; offset: number }> = [];
  let currentOffset = startOffset;

  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start: startOffset,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
    if (line.trim()) {
      lines.push({ raw: line, offset: currentOffset });
    }
    currentOffset += lineBytes;
  }

  // Rule 6: discard the last line if it fails JSON parsing (partial write)
  let lastGoodOffset = startOffset;
  const linesToProcess =
    lines.length > 0 && !isValidJson(lines[lines.length - 1]!.raw)
      ? lines.slice(0, -1)
      : lines;

  // Session-level accumulators
  let sessionId: string | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let claudeVersion: string | null = null;
  let entrypoint: string | null = null;
  let gitBranch: string | null = null;
  let permissionMode: string | null = null;
  let hasQueueOperation = false;
  let promptCount = 0;
  let assistantMessageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let webSearchRequests = 0;
  let webFetchRequests = 0;
  let totalThinkingBlocks = 0;
  const toolUseCounts = new Map<string, number>();
  const modelsSet = new Set<string>();

  let lineNumber = 0;
  for (const { raw, offset } of linesToProcess) {
    lineNumber++;
    let entry: RawSessionEntry;

    try {
      entry = JSON.parse(raw) as RawSessionEntry;
    } catch (err) {
      errors.push({
        filePath,
        lineNumber,
        rawLine: raw,
        error: String(err),
        timestamp: Date.now(),
        claudeVersion: claudeVersion ?? undefined,
      });
      continue;
    }

    // Update last good offset after each successfully parsed line
    lastGoodOffset = offset + Buffer.byteLength(raw, "utf8") + 1;

    // Extract common envelope fields
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (entry.version && !claudeVersion) claudeVersion = entry.version;
    if (entry.entrypoint && !entrypoint) entrypoint = entry.entrypoint;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
    if (entry.permissionMode && !permissionMode)
      permissionMode = entry.permissionMode;

    const ts = entry.timestamp ?? null;
    if (ts !== null) {
      if (firstTimestamp === null || ts < firstTimestamp) firstTimestamp = ts;
      if (lastTimestamp === null || ts > lastTimestamp) lastTimestamp = ts;
    }

    const type = entry.type;

    if (type === "queue-operation") {
      hasQueueOperation = true;
    } else if (type === "user") {
      if (!entry.isMeta) promptCount++;
    } else if (type === "assistant") {
      assistantMessageCount++;
      const usage = entry.message?.usage;
      const model = entry.message?.model;

      if (model) modelsSet.add(model);

      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0;
        webFetchRequests += usage.server_tool_use?.web_fetch_requests ?? 0;
      }

      // Extract tool usage and thinking blocks from content blocks
      const content = entry.message?.content;
      const contentArr = Array.isArray(content) ? content : [];
      const msgTools: string[] = [];
      let thinkingBlockCount = 0;
      for (const block of contentArr) {
        if (block.type === "tool_use" && block.name) {
          toolUseCounts.set(
            block.name,
            (toolUseCounts.get(block.name) ?? 0) + 1
          );
          msgTools.push(block.name);
        }
        if (block.type === "thinking") {
          thinkingBlockCount++;
        }
      }
      totalThinkingBlocks += thinkingBlockCount;

      // Store per-message record for detailed analysis
      const msgUuid = entry.uuid;
      if (msgUuid) {
        messages.push({
          uuid: msgUuid,
          sessionId: entry.sessionId ?? sessionId ?? "",
          timestamp: ts,
          claudeVersion: entry.version ?? claudeVersion,
          model: model ?? null,
          stopReason: entry.message?.stop_reason ?? null,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          tools: msgTools,
          thinkingBlocks: thinkingBlockCount,
        });
      }
    }
  }

  const toolUseCountsArr: ToolUseCount[] = Array.from(
    toolUseCounts.entries()
  ).map(([name, count]) => ({ name, count }));

  const session: SessionRecord | null = sessionId
    ? {
        sessionId,
        projectPath,
        sourceFile: filePath,
        firstTimestamp,
        lastTimestamp,
        claudeVersion,
        entrypoint,
        gitBranch,
        permissionMode,
        isInteractive: hasQueueOperation,
        promptCount,
        assistantMessageCount,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        webSearchRequests,
        webFetchRequests,
        toolUseCounts: toolUseCountsArr,
        models: Array.from(modelsSet),
        repoUrl: null,
        accountUuid: null,
        organizationUuid: null,
        subscriptionType: null,
        thinkingBlocks: totalThinkingBlocks,
        sourceDeleted: false,
      }
    : null;

  return { session, messages, errors, lastGoodOffset, firstKbHash };
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
