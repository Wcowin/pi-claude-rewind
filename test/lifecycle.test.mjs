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

test("binds a pending workspace snapshot to the current persisted user entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-rewind-lifecycle-"));
  const workTree = join(root, "work");
  const agentDir = join(root, "agent");
  await mkdir(workTree);
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(workTree, "code.txt"), "before\n");

  const handlers = new Map();
  const customEntries = [];
  const entries = [];
  const user = userEntry("current-user-id", "create a test file");
  const api = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: () => {},
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

  const notifications = [];
  const ctx = {
    cwd: workTree,
    hasUI: true,
    ui: {
      setStatus: () => {},
      notify: (message, level) => notifications.push({ message, level }),
      select: async () => "代码和对话一起回退（推荐）",
    },
    sessionManager: {
      getSessionId: () => "lifecycle-session",
      getEntries: () => [...entries, ...customEntries],
      getBranch: () => [...entries, ...customEntries],
      getEntry: (id) => id === user.id ? user : undefined,
      getLeafId: () => "assistant-id",
    },
  };

  await handlers.get("session_start")({}, ctx);
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
  assert.equal(await readFile(join(workTree, "code.txt"), "utf8"), "before\n");
  await assert.rejects(access(join(workTree, "created.txt")));
  assert.ok(notifications.some(({ message }) => message.includes("已恢复")));
});
