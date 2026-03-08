/**
 * Aggregator — orchestrates collection: scan → parse → schema check → store.
 *
 * Implements incremental collection with crash-safe checkpoints.
 * See doc/analysis/02-collection-strategy.md.
 */
import { discoverSessionFiles, getFileStats } from "../scanner/index.js";
import { getGitRemoteUrl } from "../git.js";
import { parseSessionFile, hashFirstKb } from "../parser/session.js";
import { collectAccountMap } from "../parser/telemetry.js";
import { checkSchema } from "../schema/monitor.js";
import type { Store } from "../store/index.js";
import type { RawSessionEntry } from "../types.js";

export interface CollectOptions {
  verbose?: boolean;
}

export interface CollectResult {
  filesProcessed: number;
  filesSkipped: number;
  filesDeleted: number;
  sessionsUpserted: number;
  messagesUpserted: number;
  accountsMatched: number;
  parseErrors: number;
  schemaChanges: string[];
}

export async function collect(
  store: Store,
  opts: CollectOptions = {}
): Promise<CollectResult> {
  const result: CollectResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    sessionsUpserted: 0,
    messagesUpserted: 0,
    accountsMatched: 0,
    parseErrors: 0,
    schemaChanges: [],
  };

  const sessionFiles = discoverSessionFiles();

  // Best-effort: build session → account mapping from telemetry
  const accountMap = collectAccountMap();

  // Accumulate entries per version for schema fingerprinting
  const entriesByVersion = new Map<string, RawSessionEntry[]>();
  // Cache repo URLs per project path to avoid re-reading .git/config for each session file
  const repoUrlCache = new Map<string, string | null>();

  for (const sf of sessionFiles) {
    const fileStats = getFileStats(sf.filePath);

    if (!fileStats) {
      // File has been deleted since discovery
      store.markSourceDeleted(sf.filePath);
      result.filesDeleted++;
      continue;
    }

    const checkpoint = store.getCheckpoint(sf.filePath);

    // Determine if file needs processing
    let startOffset = 0;

    if (checkpoint) {
      if (
        checkpoint.lastMtime === fileStats.mtime &&
        checkpoint.fileSize === fileStats.size
      ) {
        result.filesSkipped++;
        continue; // File unchanged
      }

      // File changed — check if it's an append or a rewrite.
      // Compare only the bytes that existed at checkpoint time (up to 1KB)
      // so that appended content within the first 1KB doesn't trigger rewrite.
      const compareBytes = Math.min(checkpoint.fileSize, 1024);
      const currentHash = hashFirstKb(sf.filePath, compareBytes);
      if (
        currentHash === checkpoint.firstKbHash &&
        fileStats.size >= checkpoint.fileSize
      ) {
        // Append-only — seek to last processed offset
        startOffset = checkpoint.lastByteOffset;
      } else {
        // File was rewritten — reprocess from the beginning
        startOffset = 0;
        if (opts.verbose) {
          console.log(`[rewrite detected] ${sf.filePath}`);
        }
      }
    }

    const parsed = await parseSessionFile(
      sf.filePath,
      sf.projectPath,
      startOffset
    );

    result.filesProcessed++;
    result.parseErrors += parsed.errors.length;

    // Store everything in a single transaction for crash safety
    // Resolve repo URL once per project path
    if (parsed.session && !repoUrlCache.has(sf.projectPath)) {
      repoUrlCache.set(sf.projectPath, getGitRemoteUrl(sf.projectPath));
    }
    if (parsed.session) {
      parsed.session.repoUrl = repoUrlCache.get(sf.projectPath) ?? null;

      // Best-effort account enrichment from telemetry
      const acct = accountMap.get(parsed.session.sessionId);
      if (acct) {
        parsed.session.accountUuid = acct.accountUuid;
        parsed.session.organizationUuid = acct.organizationUuid;
        parsed.session.subscriptionType = acct.subscriptionType;
      }
    }

    store.transaction(() => {
      if (parsed.session) {
        store.upsertSession(parsed.session);
        result.sessionsUpserted++;
      }

      if (parsed.messages.length > 0) {
        store.upsertMessages(parsed.messages);
        result.messagesUpserted += parsed.messages.length;
      }

      if (parsed.errors.length > 0) {
        store.addToQuarantine(parsed.errors);
      }

      store.upsertCheckpoint({
        filePath: sf.filePath,
        fileSize: fileStats.size,
        lastByteOffset: parsed.lastGoodOffset,
        lastMtime: fileStats.mtime,
        firstKbHash: parsed.firstKbHash,
        sourceDeleted: false,
      });
    });

    // Collect entries for schema fingerprinting (sample: assistant messages only)
    if (parsed.session?.claudeVersion) {
      const version = parsed.session.claudeVersion;
      if (!entriesByVersion.has(version)) {
        entriesByVersion.set(version, []);
      }
    }

    if (opts.verbose && parsed.session) {
      console.log(
        `[ok] ${sf.filePath} — session ${parsed.session.sessionId.slice(0, 8)}… ` +
          `${parsed.session.promptCount} prompts, ` +
          `${parsed.session.inputTokens.toLocaleString()} input tokens`
      );
    }
  }

  // Reconcile: mark checkpointed files that are no longer on disk as source_deleted.
  // This handles clean deletions (not just race conditions).
  const discoveredPaths = new Set(sessionFiles.map((sf) => sf.filePath));
  for (const cp of store.getAllCheckpoints()) {
    if (!discoveredPaths.has(cp.filePath) && !getFileStats(cp.filePath)) {
      store.markSourceDeleted(cp.filePath);
      result.filesDeleted++;
    }
  }

  // Best-effort: backfill account info for previously-collected sessions
  if (accountMap.size > 0) {
    result.accountsMatched = store.updateSessionAccounts(accountMap);
  }

  // Schema check: sample stored sessions per version
  // (skipped for brevity in initial implementation — triggered by diagnose command)

  return result;
}
