import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkspaceSnapshot,
  initializeShadowRepository,
  restoreWorkspaceSnapshot,
} from "../src/index.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-rewind-core-"));
  const workTree = join(root, "work");
  const gitDir = join(root, "shadow.git");
  await mkdir(join(workTree, "sub"), { recursive: true });
  return { root, workTree, gitDir };
}

test("restores modified, created, and deleted files", async (t) => {
  const { root, workTree, gitDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(workTree, "modified.txt"), "before\n");
  await writeFile(join(workTree, "sub", "deleted.txt"), "restore me\n");
  await initializeShadowRepository(gitDir, workTree);
  const before = await createWorkspaceSnapshot(gitDir, workTree, "refs/test/before", "before");

  await writeFile(join(workTree, "modified.txt"), "after\n");
  await writeFile(join(workTree, "created.txt"), "created\n");
  await rm(join(workTree, "sub", "deleted.txt"));
  const after = await createWorkspaceSnapshot(gitDir, workTree, "refs/test/after", "after");

  const count = await restoreWorkspaceSnapshot(gitDir, workTree, after, before);
  assert.equal(count, 3);
  assert.equal(await readFile(join(workTree, "modified.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(workTree, "sub", "deleted.txt"), "utf8"), "restore me\n");
  await assert.rejects(readFile(join(workTree, "created.txt"), "utf8"));
});

test("refuses to restore through a linked parent directory", async (t) => {
  const { root, workTree, gitDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  await mkdir(outside);

  await writeFile(join(workTree, "sub", "file.txt"), "before\n");
  await writeFile(join(outside, "file.txt"), "outside\n");
  await initializeShadowRepository(gitDir, workTree);
  const before = await createWorkspaceSnapshot(gitDir, workTree, "refs/test/before", "before");
  await writeFile(join(workTree, "sub", "file.txt"), "after\n");
  const after = await createWorkspaceSnapshot(gitDir, workTree, "refs/test/after", "after");

  await rm(join(workTree, "sub"), { recursive: true });
  await symlink(outside, join(workTree, "sub"));

  await assert.rejects(
    restoreWorkspaceSnapshot(gitDir, workTree, after, before),
    /链接/,
  );
  assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "outside\n");
});
