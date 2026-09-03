/**
 * auto-router — opencode plugin wired with real session signals.
 * Grill contract: two-window SessionState, gated heuristics, context-fit, stickiness, 2-axis selection.
 * Wires: filesTouched / diffHunks / toolDepth / priorErrors / lifetimeTokens via opencode events + tool hooks.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { selectModel, loadConfig, loadCatalogSync, resolveTaskType, buildCatalogFromProviders, detectBoundary } from "../../packages/router-core/src/index.js";
import type { Catalog, SessionState, Tier } from "../../packages/router-core/src/index.js";

type LiveCatalogSnapshot = Readonly<{
  catalog: Catalog;
  runtimeIDs: ReadonlySet<string>;
}>;

type RuntimeModel = { providerID: string; modelID: string };
type PendingApply = RuntimeModel & { messageID: string; agent: string };

function createLiveCatalogSnapshot(catalog: Catalog, runtimeIDs: Iterable<string>): LiveCatalogSnapshot {
  return Object.freeze({ catalog, runtimeIDs: new Set(runtimeIDs) });
}

function runtimeModelID(model: { providerID?: string; modelID?: string; id?: string } | undefined): string | undefined {
  const modelID = model?.modelID ?? model?.id;
  return model?.providerID && modelID ? `${model.providerID}/${modelID}` : undefined;
}

function parseRuntimeModelID(id: string): RuntimeModel | undefined {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) };
}

// ---- Per-session state (the real wiring) ----
type PerSession = {
  lifetimeTokens: number;
  taskTokens: number;
  filesSet: Set<string>;
  diffHunks: number;
  toolDepth: number;
  priorErrors: number;
  taskTarget: string | null;
  taskTier: Tier | null;
  actualModel: string | null;
  pendingApply: PendingApply | null;
  prevAgent?: string;
  prevMessage?: string;
  isCompacted: boolean;
  isNewSession: boolean;
  agent?: string;
};

const sessions = new Map<string, PerSession>();

function getSession(id: string): PerSession {
  let s = sessions.get(id);
  if (!s) {
    s = {
      lifetimeTokens: 0,
      taskTokens: 0,
      filesSet: new Set(),
      diffHunks: 0,
      toolDepth: 0,
      priorErrors: 0,
      taskTarget: null,
      taskTier: null,
      actualModel: null,
      pendingApply: null,
      isCompacted: false,
      isNewSession: true,
    };
    sessions.set(id, s);
  }
  return s;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function extractTextFromMessage(msg: any): string {
  if (!msg) return "";
  // OpenCode supplies message content separately in chat.message output.parts.
  if (Array.isArray(msg.parts)) return msg.parts.map((p: any) => p.text ?? p.content ?? "").join("\n");
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((c: any) => c.text ?? "").join("\n");
  return "";
}

function extractSessionState(sessionID: string, msgText: string, agentHint?: string, opts?: { forceTier?: Tier; userTag?: string }): SessionState {
  const s = getSession(sessionID);

  const promptTokens = estimateTokens(msgText);
  // Lifetime: accumulate prompt; more accurate totals will be overwritten by session.updated tokens when available
  s.lifetimeTokens += promptTokens;
  s.taskTokens += promptTokens;

  const agent = agentHint ?? s.agent ?? s.prevAgent;

  // Parse explicit tags from message
  let userTag: string | undefined = opts?.userTag;
  let forceTier: Tier | undefined = opts?.forceTier;
  if (!userTag) {
    const m = msgText.match(/\[task:([a-z_]+)\]/i);
    if (m) userTag = m[1].toLowerCase();
  }
  if (!forceTier) {
    const m = msgText.match(/\[force:(simple|medium|complex)\]/i);
    if (m) forceTier = m[1].toLowerCase() as Tier;
  }

  const state: SessionState = {
    lifetimeTokens: s.lifetimeTokens,
    currentTask: {
      promptTokens,
      taskTokens: s.taskTokens,
      filesTouched: s.filesSet.size,
      diffHunks: s.diffHunks,
      toolDepth: s.toolDepth,
      lastUserMessage: msgText,
      priorErrors: s.priorErrors,
    },
    userTag,
    forceTier,
    activeAgent: agent,
    isCompacted: s.isCompacted,
    isNewSession: s.isNewSession,
  };

  // Consume one-shot flags
  s.isCompacted = false;
  s.isNewSession = false;

  return state;
}

function resetTask(sessionID: string, newPromptTokens: number) {
  const s = getSession(sessionID);
  s.taskTokens = newPromptTokens;
  s.filesSet.clear();
  s.diffHunks = 0;
  s.toolDepth = 0;
  s.priorErrors = 0;
}

async function appendDecision(line: string): Promise<void> {
  try {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const cacheDir = `${homedir()}/.cache`;
    mkdirSync(cacheDir, { recursive: true });
    appendFileSync(`${cacheDir}/auto-router-decisions.log`, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

export const AutoRouterPlugin: Plugin = async ({ client, directory }) => {
  let config = loadConfig();
  let catalog = loadCatalogSync(config);
  let currentLiveSnapshot = createLiveCatalogSnapshot(catalog, []);
  let providerListPromise: Promise<unknown> | undefined;

  function emptyLiveSnapshot(): LiveCatalogSnapshot {
    return createLiveCatalogSnapshot(catalog, []);
  }

  function providerList(): Promise<unknown> {
    if (!providerListPromise) {
      const request = Promise.resolve().then(() => client.provider.list({ query: { directory } }));
      const tracked = request.finally(() => {
        providerListPromise = undefined;
      });
      providerListPromise = tracked;
    }
    return providerListPromise!;
  }

  async function loadLiveCatalog(): Promise<LiveCatalogSnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1500);
        providerList().then(
          (value) => {
            if (timer) clearTimeout(timer);
            resolve(value);
          },
          () => {
            if (timer) clearTimeout(timer);
            resolve(undefined);
          }
        );
      });
      if (timer) clearTimeout(timer);
      const data = (response as any)?.data ?? response;
      if (!data) {
        currentLiveSnapshot = emptyLiveSnapshot();
        return currentLiveSnapshot;
      }

      const live = buildCatalogFromProviders(data, config);
      catalog = live.models.length ? live : loadCatalogSync(config);
      currentLiveSnapshot = createLiveCatalogSnapshot(
        catalog,
        live.models.map((model) => model.runtimeId).filter((id): id is string => Boolean(id))
      );
      return currentLiveSnapshot;
    } catch {
      if (timer) clearTimeout(timer);
      currentLiveSnapshot = emptyLiveSnapshot();
      return currentLiveSnapshot;
    }
  }

  await client.app.log({
    body: {
      service: "auto-router",
      level: "info",
      message: `auto-router wired: ${catalog.models.length} models (${catalog.source}) — tracking files/diff/depth/tokens per session`,
      extra: { catalogSource: catalog.source, modelCount: catalog.models.length, directory },
    },
  }).catch(() => {});

  async function logDecision(line: string, level: "info" | "warn", extra: Record<string, unknown>): Promise<void> {
    await client.app.log({
      body: { service: "auto-router", level, message: line, extra },
    }).catch(() => {});
    await appendDecision(line);
  }

  async function selectTaskTarget(
    sessionID: string,
    session: PerSession,
    sessionState: SessionState,
    boundary: ReturnType<typeof detectBoundary>,
    prevAgent?: string,
    prevMessage?: string
  ): Promise<LiveCatalogSnapshot | undefined> {
    const liveSnapshot = await loadLiveCatalog();
    const selectionState: SessionState = {
      ...sessionState,
      currentTask: {
        ...sessionState.currentTask,
        taskTokens: sessionState.currentTask.promptTokens,
        filesTouched: 0,
        diffHunks: 0,
        toolDepth: 0,
        priorErrors: 0,
      },
    };

    let result: ReturnType<typeof selectModel>;
    try {
      result = selectModel(selectionState, liveSnapshot.catalog, config, { currentModel: null, currentTier: null, downgradeCounter: 0 }, prevAgent, prevMessage);
    } catch (error) {
      session.taskTarget = null;
      await logDecision("[auto-router] TASK ERROR selection failed", "warn", {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    if (!liveSnapshot.runtimeIDs.has(result.modelId)) {
      session.taskTarget = null;
      session.taskTier = null;
      await logDecision(
        `[auto-router] TASK RECOMMEND target=${result.modelId} source=${result.catalogSource} (no live connected proof)`,
        "info",
        { sessionID, target: result.modelId, catalogSource: result.catalogSource }
      );
      return undefined;
    }

    const taskType = resolveTaskType(selectionState, config);
    session.taskTarget = result.modelId;
    session.taskTier = result.tier;
    resetTask(sessionID, selectionState.currentTask.promptTokens);

    const line = `[auto-router] TASK SELECT s=${sessionID.slice(0, 8)} target=${result.modelId} tier=${result.tier} taskType=${taskType.type ?? "none"} via=${result.via} source=${result.catalogSource} boundary=${boundary.signals.join("+") || "initial"}`;
    await logDecision(line, "info", {
      sessionID,
      tier: result.tier,
      score: result.score,
      confidence: result.confidence,
      taskType: taskType.type,
      via: result.via,
      modelId: result.modelId,
      lifetimeTokens: sessionState.lifetimeTokens,
      boundary,
      catalogSource: result.catalogSource,
    });
    return liveSnapshot;
  }

  async function applyTaskTarget(
    sessionID: string,
    session: PerSession,
    message: { id: string; agent: string; model: RuntimeModel & { variant?: string } },
    liveSnapshot: LiveCatalogSnapshot,
    notify: boolean
  ): Promise<void> {
    if (!session.taskTarget || !liveSnapshot.runtimeIDs.has(session.taskTarget)) return;
    const target = parseRuntimeModelID(session.taskTarget);
    if (!target) {
      await logDecision(`[auto-router] TASK APPLY skipped malformed=${session.taskTarget}`, "warn", {
        sessionID,
        target: session.taskTarget,
      });
      return;
    }
    if (runtimeModelID(message.model) === session.taskTarget) return;

    message.model = target;
    session.pendingApply = { ...target, messageID: message.id, agent: message.agent };
    if (!notify) return;

    await client.tui.showToast({
      body: {
        title: "Auto-router",
        message: `Using ${session.taskTarget} for this task`,
        variant: "info",
        duration: 3000,
      },
    }).catch(() => {});
  }

  return {
    // Keep config live: if user edits auto-router.json, next turn picks it up
    // (opencode doesn't hot-reload plugin config, so we reload lazily on each turn)
    config: async () => {
      try {
        config = loadConfig();
        catalog = loadCatalogSync(config);
        currentLiveSnapshot = createLiveCatalogSnapshot(catalog, []);
      } catch {}
    },

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID;
      const s = getSession(sessionID);
      const msgText = extractTextFromMessage({ parts: output.parts });
      const agent = input.agent;
      if (agent) s.agent = agent;

      const prevAgent = s.prevAgent;
      const prevMessage = s.prevMessage;
      const sessionState = extractSessionState(sessionID, msgText, agent);
      const boundary = detectBoundary(sessionState, prevAgent, prevMessage);
      s.prevAgent = agent ?? sessionState.activeAgent;
      s.prevMessage = msgText;
      const requestSnapshot = currentLiveSnapshot;
      const shouldSelect = !s.taskTarget || boundary.isBoundary || !requestSnapshot.runtimeIDs.has(s.taskTarget);
      s.pendingApply = null;

      if (shouldSelect) {
        const selectedSnapshot = await selectTaskTarget(sessionID, s, sessionState, boundary, prevAgent, prevMessage);
        if (!selectedSnapshot) return;
        await applyTaskTarget(sessionID, s, output.message, selectedSnapshot, true);
        return;
      }
      await applyTaskTarget(sessionID, s, output.message, requestSnapshot, false);
    },

    "chat.params": async (input) => {
      const sessionID = input.sessionID;
      const s = getSession(sessionID);
      const actual = runtimeModelID(input.model) ?? "undefined";
      s.actualModel = actual;
      const pending = s.pendingApply;
      if (!pending) return;
      if (input.message.id !== pending.messageID || input.agent !== pending.agent) return;

      s.pendingApply = null;
      const expected = `${pending.providerID}/${pending.modelID}`;
      const matches = actual === expected;
      const line = matches
        ? `[auto-router] TASK APPLY ${expected}`
        : `[auto-router] TASK APPLY mismatch expected=${expected} actual=${actual}`;
      await logDecision(line, matches ? "info" : "warn", { sessionID, expected, actual });
    },

    // ---- Tool hooks: wire filesTouched / toolDepth / priorErrors ----
    "tool.execute.before": async (input, output) => {
      const sessionID: string = (input as any).sessionID ?? "global";
      const s = getSession(sessionID);
      s.toolDepth += 1;

      // Track file args (read, edit, write, patch, bash file ops)
      const args = (output as any).args ?? (input as any).args ?? {};
      const candidates: string[] = [];
      if (typeof args.filePath === "string") candidates.push(args.filePath);
      if (typeof args.path === "string") candidates.push(args.path);
      if (typeof args.file === "string") candidates.push(args.file);
      if (Array.isArray(args.files)) candidates.push(...args.files.filter((x: any) => typeof x === "string"));
      if (typeof args.command === "string") {
        // crude bash file extraction: look for file-like tokens
        const m = args.command.match(/([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,6})/g);
        if (m) candidates.push(...m.slice(0, 3));
      }
      for (const f of candidates) {
        // Normalize: keep last 2 path segments to deduplicate
        const norm = f.split("/").slice(-2).join("/");
        s.filesSet.add(norm);
      }
    },

    "tool.execute.after": async (input, output) => {
      const sessionID: string = (input as any).sessionID ?? "global";
      const s = getSession(sessionID);
      // Detect errors: output contains error marker or non-zero status
      const out = (output as any).output ?? "";
      const title = (output as any).title ?? "";
      if (typeof out === "string" && out.match(/error|failed|exception|not found/i) && out.length < 5000) {
        // Only count as priorError if tool failed and output suggests error — use heuristic to avoid false positives from code containing "error"
        if ((input as any).tool !== "read" || out.toLowerCase().includes("error")) {
          s.priorErrors += 1;
        }
      }
      if (typeof title === "string" && title.toLowerCase().includes("error")) s.priorErrors += 1;

      // Track outputPaths / files from tool results if any
      const meta = (output as any).metadata;
      if (meta?.filePath) s.filesSet.add(String(meta.filePath).split("/").slice(-2).join("/"));
      if (Array.isArray((output as any).outputPaths)) {
        for (const p of (output as any).outputPaths) s.filesSet.add(String(p).split("/").slice(-2).join("/"));
      }
    },

    // ---- Event bus: diff, tokens, compaction, agent switches, step failures ----
    event: async ({ event }) => {
      const anyEvent = event as any;
      const sessionID: string = anyEvent.properties?.sessionID ?? anyEvent.properties?.sessionId ?? "global";

      switch (event.type) {
        case "session.created": {
          const s = getSession(sessionID);
          s.lifetimeTokens = 0;
          s.taskTokens = 0;
          s.filesSet.clear();
          s.diffHunks = 0;
          s.toolDepth = 0;
          s.priorErrors = 0;
          s.isNewSession = true;
          s.taskTarget = null;
          s.taskTier = null;
          s.actualModel = null;
          s.pendingApply = null;
          break;
        }
        case "session.updated": {
          const info = anyEvent.properties?.info;
          if (info?.tokens) {
            const t = info.tokens as { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
            const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
            // Overwrite with authoritative total if larger than estimate
            const s = getSession(sessionID);
            if (total > s.lifetimeTokens) s.lifetimeTokens = total;
          }
          if (info?.agent) getSession(sessionID).agent = info.agent;
          if (info?.summary?.diffs) {
            const diffs = info.summary.diffs as Array<{ additions: number; deletions: number }>;
            const s = getSession(sessionID);
            const hunks = diffs.reduce((acc: number, d: any) => acc + Math.ceil(((d.additions ?? 0) + (d.deletions ?? 0)) / 20), 0);
            if (hunks > s.diffHunks) s.diffHunks = hunks;
            if (info.summary.files) s.filesSet.add(`__summary_files_${info.summary.files}`); // placeholder to count files if needed
          }
          break;
        }
        case "session.diff": {
          const diffs = anyEvent.properties?.diff as Array<{ additions: number; deletions: number; file?: string }>;
          if (Array.isArray(diffs)) {
            const s = getSession(sessionID);
            const hunks = diffs.reduce((acc, d: any) => acc + Math.ceil(((d.additions ?? 0) + (d.deletions ?? 0)) / 20), 0) || diffs.length;
            s.diffHunks = Math.max(s.diffHunks, hunks);
            for (const d of diffs as any[]) if (d.file) s.filesSet.add(String(d.file).split("/").slice(-2).join("/"));
          }
          break;
        }
        case "file.edited":
        case "file.watcher.updated": {
          const file = anyEvent.properties?.file;
          if (file) getSession(sessionID).filesSet.add(String(file).split("/").slice(-2).join("/"));
          // also bump diff estimate slightly
          getSession(sessionID).diffHunks += 1;
          break;
        }
        case "session.compacted":
        case "session.next.compaction.ended":
        case "session.next.compaction.started": {
          const s = getSession(sessionID);
          s.isCompacted = true;
          s.lifetimeTokens = Math.floor(s.lifetimeTokens * 0.3); // approximate compression; authoritative tokens will overwrite via session.updated
          s.taskTokens = Math.floor(s.taskTokens * 0.3);
          break;
        }
        case "session.next.agent.switched": {
          getSession(sessionID).agent = anyEvent.properties?.agent;
          break;
        }
        case "session.next.model.switched": {
          const m = anyEvent.properties?.model;
          if (m?.modelID) {
            const s = getSession(sessionID);
            s.actualModel = m.providerID ? `${m.providerID}/${m.modelID}` : m.modelID;
          }
          break;
        }
        case "session.next.step.ended": {
          const toks = anyEvent.properties?.tokens as { input: number; output: number; reasoning: number } | undefined;
          if (toks) {
            const s = getSession(sessionID);
            const total = (toks.input ?? 0) + (toks.output ?? 0) + (toks.reasoning ?? 0);
            // If we get authoritative step tokens, ensure lifetime reflects them
            if (total > 0) {
              // Don't double-count; step tokens are already included in session.updated but ensure monotonic
              s.lifetimeTokens = Math.max(s.lifetimeTokens, total);
            }
          }
          const files: string[] | undefined = anyEvent.properties?.files;
          if (Array.isArray(files)) {
            const s = getSession(sessionID);
            for (const f of files) s.filesSet.add(String(f).split("/").slice(-2).join("/"));
          }
          // Reset toolDepth slightly at step boundary? Keep accumulating within task; level off depth over time
          // Instead keep depth as max since last boundary — step end is not a reset.
          break;
        }
        case "session.next.step.failed":
        case "session.next.tool.failed":
        case "session.error": {
          getSession(sessionID).priorErrors += 1;
          break;
        }
        case "session.next.tool.called":
        case "session.next.tool.input.started": {
          getSession(sessionID).toolDepth += 1;
          break;
        }
        default:
          break;
      }
    },
  };
};
