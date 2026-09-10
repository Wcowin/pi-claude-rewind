// Claude-style rewind for Pi.
// Double Escape opens Pi's native conversation tree. Selecting a user prompt can
// restore both the conversation position and the matching workspace snapshot.

import { getAgentDir, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "claude-rewind";
const FORMAT_VERSION = 2;
const MAX_CHECKPOINTS = 100;
const GIT_TIMEOUT_MS = 120_000;

interface Checkpoint {
  entryId: string;
  commit: string;
  prompt: string;
  createdAt: string;
}

interface RedoPoint {
  commit: string;
  conversationLeafId: string | null;
  createdAt: string;
}

interface Manifest {
  version: number;
  sessionId: string;
  cwd: string;
  checkpoints: Record<string, Checkpoint>;
  order: string[];
  redo?: RedoPoint;
}

interface PendingSnapshot {
  commit: string;
  prompt: string;
  createdAt: string;
}

interface RuntimeState {
  cwd?: string;
  sessionId?: string;
  stateDir?: string;
  gitDir?: string;
  manifest?: Manifest;
  pending?: PendingSnapshot;
  ready: boolean;
  suppressTreeRestore: boolean;
  operation: Promise<void>;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function defaultManifest(sessionId: string, cwd: string): Manifest {
  return {
    version: FORMAT_VERSION,
    sessionId,
    cwd,
    checkpoints: {},
    order: [],
  };
}

async function git(
  gitDir: string,
  workTree: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: workTree,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_AUTHOR_NAME: "Pi Rewind",
      GIT_AUTHOR_EMAIL: "pi-rewind@localhost",
      GIT_COMMITTER_NAME: "Pi Rewind",
      GIT_COMMITTER_EMAIL: "pi-rewind@localhost",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { stdout, stderr };
}

async function saveManifest(stateDir: string, manifest: Manifest): Promise<void> {
  const path = join(stateDir, "manifest.json");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function loadManifest(stateDir: string, sessionId: string, cwd: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, "manifest.json"), "utf8")) as Manifest;
    if (parsed.version === FORMAT_VERSION && parsed.sessionId === sessionId && parsed.cwd === cwd) {
      parsed.checkpoints ??= {};
      parsed.order ??= [];
      return parsed;
    }
  } catch {
    // A missing or invalid manifest starts a fresh history for this session.
  }
  return defaultManifest(sessionId, cwd);
}

export async function initializeShadowRepository(gitDir: string, workTree: string): Promise<void> {
  await mkdir(gitDir, { recursive: true });
  try {
    await git(gitDir, workTree, ["rev-parse", "--is-bare-repository"]);
  } catch {
    await execFileAsync("git", ["init", "--bare", gitDir], {
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
    });
  }

  const excludePath = join(gitDir, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(
    excludePath,
    [
      ".git/",
      ".jj/",
      ".svn/",
      ".hg/",
      ".DS_Store",
      "node_modules/",
      "DerivedData/",
      ".build/",
      "Pods/",
      "Carthage/Build/",
      "*.xcuserstate",
      "xcuserdata/",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function updateSnapshotRef(
  gitDir: string,
  workTree: string,
  refName: string,
  commit: string,
): Promise<void> {
  await git(gitDir, workTree, ["update-ref", refName, commit]);
}

export async function createWorkspaceSnapshot(
  gitDir: string,
  workTree: string,
  refName: string,
  message: string,
): Promise<string> {
  const indexPath = join(gitDir, `rewind-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    await git(gitDir, workTree, ["read-tree", "--empty"], env);
    await git(gitDir, workTree, ["add", "-A", "--", "."], env);
    const tree = (await git(gitDir, workTree, ["write-tree"], env)).stdout.trim();
    const commit = (await git(gitDir, workTree, ["commit-tree", tree, "-m", message], env)).stdout.trim();
    await updateSnapshotRef(gitDir, workTree, refName, commit);
    return commit;
  } finally {
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
  }
}

function parseNameStatusZ(output: string): Array<{ status: string; path: string }> {
  const fields = output.split("\0");
  const changes: Array<{ status: string; path: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status && path) changes.push({ status, path });
  }
  return changes;
}

function assertSafeRelativePath(workTree: string, path: string): string {
  if (!path || path.includes("\0")) throw new Error("快照包含无效路径");
  const absolute = resolve(workTree, path);
  const rel = relative(workTree, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || resolve(workTree, rel) !== absolute) {
    throw new Error(`拒绝恢复工作区外的路径：${path}`);
  }
  return absolute;
}

async function targetSymlinks(gitDir: string, workTree: string, commit: string): Promise<Set<string>> {
  const output = (await git(gitDir, workTree, ["ls-tree", "-r", "-z", commit])).stdout;
  const links = new Set<string>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const metadata = record.slice(0, tab);
    const path = record.slice(tab + 1);
    if (metadata.startsWith("120000 ")) links.add(path);
  }
  return links;
}

async function pathHasLinkedAncestor(workTree: string, absolutePath: string): Promise<boolean> {
  let current = absolutePath;
  while (current !== workTree && current.startsWith(`${workTree}${sep}`)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (current === absolutePath && stat.isFile() && stat.nlink > 1)) return true;
    } catch {
      // Missing path components are safe; checkout-index may create them.
    }
    current = dirname(current);
  }
  return false;
}

async function verifyChangedPathsAreRegular(
  gitDir: string,
  workTree: string,
  targetCommit: string,
  changes: Array<{ status: string; path: string }>,
): Promise<void> {
  const linksInTarget = await targetSymlinks(gitDir, workTree, targetCommit);
  const unsafe: string[] = [];

  for (const change of changes) {
    const absolute = assertSafeRelativePath(workTree, change.path);
    if (linksInTarget.has(change.path) || await pathHasLinkedAncestor(workTree, absolute)) {
      unsafe.push(change.path);
    }
  }

  if (unsafe.length > 0) {
    const shown = unsafe.slice(0, 5).join(", ");
    const suffix = unsafe.length > 5 ? ` 等 ${unsafe.length} 个路径` : "";
    throw new Error(`为避免写穿链接，已取消恢复：${shown}${suffix}`);
  }
}

async function removeEmptyParents(workTree: string, absolutePath: string): Promise<void> {
  let current = dirname(absolutePath);
  while (current !== workTree && current.startsWith(`${workTree}${sep}`)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

export async function restoreWorkspaceSnapshot(
  gitDir: string,
  workTree: string,
  currentCommit: string,
  targetCommit: string,
): Promise<number> {
  const diff = await git(gitDir, workTree, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    currentCommit,
    targetCommit,
  ]);
  const changes = parseNameStatusZ(diff.stdout);
  if (changes.length === 0) return 0;

  await verifyChangedPathsAreRegular(gitDir, workTree, targetCommit, changes);

  const indexPath = join(gitDir, `restore-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(gitDir, workTree, ["read-tree", targetCommit], env);
    const restorePaths = changes
      .filter((change) => !change.status.startsWith("D"))
      .map((change) => change.path);

    const batchSize = 100;
    for (let index = 0; index < restorePaths.length; index += batchSize) {
      await git(
        gitDir,
        workTree,
        ["checkout-index", "-f", "--", ...restorePaths.slice(index, index + batchSize)],
        env,
      );
    }

    for (const change of changes) {
      if (!change.status.startsWith("D")) continue;
      const absolute = assertSafeRelativePath(workTree, change.path);
      await rm(absolute, { force: true });
      await removeEmptyParents(workTree, absolute);
    }
  } finally {
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
  }

  return changes.length;
}

function textFromUserEntry(entry: SessionEntry | undefined): string | undefined {
  if (!entry || entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function latestUserEntry(entries: SessionEntry[]): SessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (textFromUserEntry(entry) !== undefined) return entry;
  }
  return undefined;
}

function checkpointFromCustomEntry(entry: SessionEntry): Checkpoint | undefined {
  if (entry.type !== "custom" || entry.customType !== EXTENSION_ID) return undefined;
  const data = entry.data as Partial<Checkpoint> & { version?: number; kind?: string } | undefined;
  if (
    data?.version !== FORMAT_VERSION ||
    data.kind !== "checkpoint" ||
    typeof data.entryId !== "string" ||
    typeof data.commit !== "string" ||
    typeof data.prompt !== "string" ||
    typeof data.createdAt !== "string"
  ) return undefined;
  return {
    entryId: data.entryId,
    commit: data.commit,
    prompt: data.prompt,
    createdAt: data.createdAt,
  };
}

function mergeSessionCheckpoints(manifest: Manifest, entries: SessionEntry[]): void {
  for (const entry of entries) {
    const checkpoint = checkpointFromCustomEntry(entry);
    if (!checkpoint) continue;
    manifest.checkpoints[checkpoint.entryId] = checkpoint;
    manifest.order = manifest.order.filter((id) => id !== checkpoint.entryId);
    manifest.order.push(checkpoint.entryId);
  }
}

function checkpointRef(entryId: string): string {
  return `refs/pi-rewind/checkpoints/${safeId(entryId)}`;
}

function pendingRef(): string {
  return "refs/pi-rewind/pending/current";
}

function emergencyRef(): string {
  return `refs/pi-rewind/emergency/latest`;
}

function queue(state: RuntimeState, operation: () => Promise<void>): Promise<void> {
  const next = state.operation.then(operation, operation);
  state.operation = next.catch(() => {});
  return next;
}

async function pruneCheckpoints(state: RuntimeState): Promise<void> {
  const manifest = state.manifest;
  if (!manifest || !state.gitDir || !state.cwd) return;
  while (manifest.order.length > MAX_CHECKPOINTS) {
    const oldest = manifest.order.shift();
    if (!oldest) break;
    delete manifest.checkpoints[oldest];
    try {
      await git(state.gitDir, state.cwd, ["update-ref", "-d", checkpointRef(oldest)]);
    } catch {
      // Ref cleanup is best effort; manifest pruning still bounds the visible history.
    }
  }
}

export default function claudeRewind(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    ready: false,
    suppressTreeRestore: false,
    operation: Promise.resolve(),
  };

  function updateStatus(ctx: { ui: { setStatus: (id: string, text: string | undefined) => void } }): void {
    ctx.ui.setStatus(EXTENSION_ID, state.ready ? "↶ Rewind" : undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    await queue(state, async () => {
      const sessionId = ctx.sessionManager.getSessionId();
      const stateDir = join(getAgentDir(), "file-history", EXTENSION_ID, safeId(sessionId));
      const gitDir = join(stateDir, "repo.git");
      await mkdir(stateDir, { recursive: true });
      await initializeShadowRepository(gitDir, ctx.cwd);

      state.cwd = ctx.cwd;
      state.sessionId = sessionId;
      state.stateDir = stateDir;
      state.gitDir = gitDir;
      state.manifest = await loadManifest(stateDir, sessionId, ctx.cwd);
      mergeSessionCheckpoints(state.manifest, ctx.sessionManager.getEntries());
      state.pending = undefined;
      state.ready = true;
      state.suppressTreeRestore = false;
      await pruneCheckpoints(state);
      await saveManifest(stateDir, state.manifest);
      updateStatus(ctx);
    }).catch((error) => {
      state.ready = false;
      ctx.ui.notify(`回退插件初始化失败：${error instanceof Error ? error.message : String(error)}`, "error");
    });
  });

  // Pi emits before_agent_start before it persists the new user message. Capture
  // the workspace here, but wait for context to bind the snapshot to the real
  // SessionEntry id. Looking up the latest user entry here would bind to the
  // previous prompt and shift every checkpoint by one.
  pi.on("before_agent_start", async (event, ctx) => {
    await queue(state, async () => {
      if (!state.ready || !state.gitDir || !state.cwd || !state.manifest) return;
      const createdAt = new Date().toISOString();
      const commit = await createWorkspaceSnapshot(
        state.gitDir,
        state.cwd,
        pendingRef(),
        `Pending prompt at ${createdAt}`,
      );
      state.pending = {
        commit,
        prompt: event.prompt.slice(0, 500),
        createdAt,
      };
      state.manifest.redo = undefined;
    }).catch((error) => {
      state.pending = undefined;
      ctx.ui.notify(`创建回退点失败：${error instanceof Error ? error.message : String(error)}`, "warning");
    });
  });

  // Pi persists the user message after its message_end extension handlers, then
  // emits context immediately before the provider request. This is the first
  // documented hook where the new user SessionEntry (and stable id) exists while
  // the agent has not produced any edits yet.
  pi.on("context", async (_event, ctx) => {
    await queue(state, async () => {
      if (!state.ready || !state.pending || !state.gitDir || !state.cwd || !state.stateDir || !state.manifest) return;
      const userEntry = latestUserEntry(ctx.sessionManager.getBranch());
      if (!userEntry) throw new Error("Pi 尚未保存当前用户消息");

      const pending = state.pending;
      state.pending = undefined;
      await updateSnapshotRef(state.gitDir, state.cwd, checkpointRef(userEntry.id), pending.commit);
      const checkpoint: Checkpoint = {
        entryId: userEntry.id,
        commit: pending.commit,
        prompt: (textFromUserEntry(userEntry) ?? pending.prompt).slice(0, 500),
        createdAt: pending.createdAt,
      };
      state.manifest.checkpoints[userEntry.id] = checkpoint;
      state.manifest.order = state.manifest.order.filter((id) => id !== userEntry.id);
      state.manifest.order.push(userEntry.id);
      await pruneCheckpoints(state);
      await saveManifest(state.stateDir, state.manifest);

      // Pi's documented persistence mechanism keeps the exact checkpoint ↔
      // conversation-node relationship in the session JSONL as well.
      pi.appendEntry(EXTENSION_ID, {
        version: FORMAT_VERSION,
        kind: "checkpoint",
        ...checkpoint,
      });
      updateStatus(ctx);
    }).catch((error) => {
      ctx.ui.notify(`绑定回退点失败：${error instanceof Error ? error.message : String(error)}`, "warning");
    });
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (state.suppressTreeRestore) {
      state.suppressTreeRestore = false;
      return;
    }
    if (!state.ready || !state.gitDir || !state.cwd || !state.stateDir || !state.manifest) return;

    const targetEntry = ctx.sessionManager.getEntry(event.preparation.targetId);
    const checkpoint = state.manifest.checkpoints[event.preparation.targetId];
    const isUserPrompt = textFromUserEntry(targetEntry) !== undefined;

    if (!isUserPrompt) return;
    if (!checkpoint) {
      if (ctx.hasUI) {
        const choice = await ctx.ui.select("该任务发生在 Rewind 启用前，没有对应的代码状态", [
          "仅切换对话（代码保持不变）",
          "取消",
        ]);
        if (choice !== "仅切换对话（代码保持不变）") return { cancel: true };
      }
      return;
    }

    if (!ctx.hasUI) return { cancel: true };
    if (event.preparation.userWantsSummary) {
      ctx.ui.notify("同步恢复代码和对话时不支持分支摘要；请重新选择并选择“不生成摘要”", "warning");
      return { cancel: true };
    }

    const prompt = checkpoint.prompt.replace(/\s+/g, " ").trim();
    const title = prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt;
    const choice = await ctx.ui.select(`恢复到执行「${title || "所选任务"}」之前`, [
      "恢复代码和对话（推荐）",
      "仅切换对话（代码保持不变）",
      "仅恢复代码（对话保持不变）",
      "取消",
    ]);

    if (!choice || choice === "取消") return { cancel: true };
    if (choice === "仅切换对话（代码保持不变）") return;

    try {
      await queue(state, async () => {
        if (!state.gitDir || !state.cwd || !state.stateDir || !state.manifest) return;
        const emergency = await createWorkspaceSnapshot(
          state.gitDir,
          state.cwd,
          emergencyRef(),
          "Before rewind",
        );
        state.manifest.redo = {
          commit: emergency,
          conversationLeafId: event.preparation.oldLeafId,
          createdAt: new Date().toISOString(),
        };
        await saveManifest(state.stateDir, state.manifest);
        const changed = await restoreWorkspaceSnapshot(
          state.gitDir,
          state.cwd,
          emergency,
          checkpoint.commit,
        );
        ctx.ui.notify(`已恢复 ${changed} 个文件变更`, "info");
      });
    } catch (error) {
      ctx.ui.notify(`代码恢复失败，对话未回退：${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }

    if (choice === "仅恢复代码（对话保持不变）") return { cancel: true };
    return;
  });

  pi.registerCommand("rewind-status", {
    description: "查看 Rewind 历史恢复点和最近恢复状态",
    handler: async (_args, ctx) => {
      if (!state.ready || !state.manifest) {
        ctx.ui.notify("回退插件尚未就绪", "warning");
        return;
      }
      const undoLatestRestore = state.manifest.redo ? "可撤销" : "无";
      ctx.ui.notify(
        `历史恢复点：${state.manifest.order.length}/${MAX_CHECKPOINTS}；最近一次恢复：${undoLatestRestore}。恢复点表示拥有代码状态的用户任务数，不是回退次数。`,
        "info",
      );
    },
  });

  pi.registerCommand("redo-rewind", {
    description: "撤销最近一次代码和对话恢复",
    handler: async (_args, ctx) => {
      if (!state.ready || !state.gitDir || !state.cwd || !state.stateDir || !state.manifest?.redo) {
        ctx.ui.notify("没有可撤销的恢复操作", "warning");
        return;
      }

      const redo = state.manifest.redo;
      try {
        await queue(state, async () => {
          if (!state.gitDir || !state.cwd || !state.stateDir || !state.manifest) return;
          const current = await createWorkspaceSnapshot(
            state.gitDir,
            state.cwd,
            "refs/pi-rewind/emergency/before-redo",
            "Before redo",
          );
          await restoreWorkspaceSnapshot(state.gitDir, state.cwd, current, redo.commit);
          state.manifest.redo = undefined;
          await saveManifest(state.stateDir, state.manifest);
        });

        if (redo.conversationLeafId && redo.conversationLeafId !== ctx.sessionManager.getLeafId()) {
          state.suppressTreeRestore = true;
          const result = await ctx.navigateTree(redo.conversationLeafId, { summarize: false });
          if (result.cancelled) state.suppressTreeRestore = false;
        }
        ctx.ui.notify("已撤销最近一次恢复，代码和对话已回到操作前", "info");
      } catch (error) {
        state.suppressTreeRestore = false;
        ctx.ui.notify(`撤销恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await state.operation.catch(() => {});
    ctx.ui.setStatus(EXTENSION_ID, undefined);
  });
}
