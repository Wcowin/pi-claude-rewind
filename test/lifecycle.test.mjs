import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension from "../src/index.ts";

function userEntry(id, prompt) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: prompt, timestamp: Date.now() },
  };
}

const cases = [
  {
    name: "Chinese",
    locale: "zh-CN",
    restoreBoth: "恢复代码和对话（推荐）",
    title: "恢复到执行「create a test file」之前",
    options: [
      "恢复代码和对话（推荐）",
      "仅切换对话（代码保持不变）",
      "仅恢复代码（对话保持不变）",
      "取消",
    ],
    restored: "已恢复 2 个文件变更",
    statusDescription: "查看 Rewind 历史恢复点和最近恢复状态",
    redoDescription: "撤销最近一次代码和对话恢复",
    status: "历史恢复点：1/100；最近一次恢复：可撤销。恢复点表示拥有代码状态的用户任务数，不是回退次数。",
  },
  {
    name: "English",
    locale: "en",
    restoreBoth: "Restore workspace and conversation (recommended)",
    title: "Restore to before “create a test file” was executed",
    options: [
      "Restore workspace and conversation (recommended)",
      "Switch conversation only (keep workspace unchanged)",
      "Restore workspace only (keep conversation unchanged)",
      "Cancel",
    ],
    restored: "Restored 2 file changes",
    statusDescription: "Show Rewind restore points and latest restore status",
    redoDescription: "Undo the most recent workspace and conversation restore",
    status: "Historical restore points: 1/100; undo latest restore: available. A restore point is a user task with workspace state, not a restore count.",
  },
];

for (const expected of cases) {
  test(`${expected.name} UI binds and restores the current user entry`, { concurrency: false }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `pi-claude-rewind-${expected.locale}-`));
    const workTree = join(root, "work");
    const agentDir = join(root, "agent");
    await mkdir(workTree);
    await mkdir(agentDir);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousLocale = process.env.PI_CLAUDE_REWIND_LOCALE;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CLAUDE_REWIND_LOCALE = expected.locale;
    t.after(async () => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousLocale === undefined) delete process.env.PI_CLAUDE_REWIND_LOCALE;
      else process.env.PI_CLAUDE_REWIND_LOCALE = previousLocale;
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(workTree, "code.txt"), "before\n");

    const handlers = new Map();
    const commands = new Map();
    const customEntries = [];
    const entries = [];
    const user = userEntry("current-user-id", "create a test file");
    const api = {
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, spec) => commands.set(name, spec),
      appendEntry: (customType, data) => customEntries.push({
        type: "custom",
        id: `custom-${customEntries.length}`,
        parentId: user.id,
        timestamp: new Date().toISOString(),
        customType,
        data,
      }),
    };
    extension(api);

    assert.equal(commands.get("rewind-status").description, expected.statusDescription);
    assert.equal(commands.get("redo-rewind").description, expected.redoDescription);

    const notifications = [];
    const statuses = [];
    const selections = [];
    const ctx = {
      cwd: workTree,
      hasUI: true,
      ui: {
        setStatus: (id, text) => statuses.push({ id, text }),
        notify: (message, level) => notifications.push({ message, level }),
        select: async (title, options) => {
          selections.push({ title, options });
          return expected.restoreBoth;
        },
      },
      sessionManager: {
        getSessionId: () => `lifecycle-${expected.locale}`,
        getEntries: () => [...entries, ...customEntries],
        getBranch: () => [...entries, ...customEntries],
        getEntry: (id) => id === user.id ? user : undefined,
        getLeafId: () => "assistant-id",
      },
    };

    await handlers.get("session_start")({}, ctx);
    assert.deepEqual(statuses.at(-1), { id: "claude-rewind", text: "↶ Rewind" });
    await handlers.get("before_agent_start")({ prompt: "create a test file" }, ctx);
    assert.equal(customEntries.length, 0, "before_agent_start must not bind to the previous message");

    entries.push(user); // Pi persists the user message before context.
    await handlers.get("context")({ messages: [] }, ctx);
    assert.equal(customEntries.length, 1);
    assert.equal(customEntries[0].data.entryId, user.id);

    await writeFile(join(workTree, "code.txt"), "after\n");
    await writeFile(join(workTree, "created.txt"), "new\n");
    const result = await handlers.get("session_before_tree")({
      preparation: {
        targetId: user.id,
        oldLeafId: "assistant-id",
        commonAncestorId: null,
        entriesToSummarize: [],
        userWantsSummary: false,
      },
      signal: new AbortController().signal,
    }, ctx);

    assert.notEqual(result?.cancel, true);
    assert.deepEqual(selections.at(-1), {
      title: expected.title,
      options: expected.options,
    });
    assert.equal(await readFile(join(workTree, "code.txt"), "utf8"), "before\n");
    await assert.rejects(access(join(workTree, "created.txt")));
    assert.ok(notifications.some(({ message }) => message === expected.restored));

    await commands.get("rewind-status").handler("", ctx);
    assert.ok(notifications.some(({ message }) => message === expected.status));
  });
}
