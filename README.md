# pi-claude-rewind

Claude Code-style synchronized conversation and workspace rewind for [Pi](https://pi.dev).

Pi already has a native conversation tree. This extension connects each user-message node to an isolated workspace snapshot, so navigating back can restore both sides of the session together.

## Features

- Double `Escape` opens Pi's native conversation tree
- A checkpoint is created automatically before every user prompt
- Restore workspace and conversation together
- Restore conversation only
- Restore workspace only
- `/redo-rewind` restores the state from immediately before the latest rewind
- Checkpoints survive `/resume` and Pi restarts
- Exact checkpoint-to-message binding through Pi session entry IDs
- Snapshot metadata is persisted with `pi.appendEntry()` in the session tree
- Isolated shadow Git storage: no commits, branches, index changes, or resets in the user's repository
- Tracks ordinary files, including untracked files and changes made through shell commands
- Refuses to restore through symbolic links or hard links
- Keeps up to 100 checkpoints per session

## Requirements

- Pi `0.85.1` or newer
- Node.js `22.19.0` or newer
- Git available on `PATH`

The workspace itself does not need to be a Git repository.

## Install

```sh
pi install npm:pi-claude-rewind
```

Until the npm package is published, install from GitHub:

```sh
pi install git:github.com/Wcowin/pi-claude-rewind
```

Or install a local checkout:

```sh
pi install /absolute/path/to/pi-claude-rewind
```

## Recommended Pi settings

Add these values to `~/.pi/agent/settings.json`, or set them through `/settings`:

```json
{
  "doubleEscapeAction": "tree",
  "treeFilterMode": "user-only",
  "branchSummary": {
    "skipPrompt": true
  }
}
```

- `doubleEscapeAction: "tree"` makes double `Escape` open the native tree.
- `treeFilterMode: "user-only"` makes the picker resemble Claude Code's prompt list.
- `branchSummary.skipPrompt: true` removes an extra summary question from the rewind flow.

Reload Pi after installation or configuration changes:

```text
/reload
```

## Usage

1. Work normally. A checkpoint is captured before each prompt.
2. Clear the input editor.
3. Press `Escape` twice.
4. Select a previous user prompt.
5. Choose an action:

```text
Workspace + conversation (recommended)
Conversation only
Workspace only
Cancel
```

When a user prompt is selected, Pi natively moves the conversation leaf to that prompt's parent and restores the selected prompt into the editor. The extension restores the workspace snapshot associated with the same message entry ID.

### Commands

```text
/rewind-status   Show checkpoint and redo status
/redo-rewind     Restore workspace and conversation to before the latest rewind
```

## How it works

Pi emits `before_agent_start` before the current user message has been persisted. The extension snapshots the workspace there, then waits for Pi's `context` event. At `context`, Pi has persisted the user message and assigned its stable session-tree entry ID, but the model has not yet made edits. The extension binds the pending snapshot to that exact ID.

During native `/tree` navigation, `session_before_tree` receives the selected `targetId`. The extension looks up the matching snapshot, saves an emergency redo point, restores the workspace, and only then allows Pi to navigate the conversation. A failed workspace restore cancels conversation navigation.

Snapshots use a private bare Git object database under Pi's agent directory:

```text
<pi-agent-dir>/file-history/claude-rewind/<session-id>/
```

This does not modify the project's `.git` directory, index, branch, commits, or reflog.

## Safety and limitations

- A checkpoint can only restore changes made after the extension was installed and loaded.
- Remote side effects cannot be rewound: API calls, database mutations, deployments, messages, and similar actions remain in effect.
- Ignored build/dependency directories such as `.git`, `node_modules`, `DerivedData`, `.build`, `Pods`, and `Carthage/Build` are excluded.
- Symbolic links, hard links, and paths beneath linked directories are rejected rather than restored.
- The extension snapshots all non-excluded workspace files. Very large repositories may take longer and use significant disk space.
- Git objects are content-addressed and deduplicated, but checkpoint storage still requires maintenance in long-running sessions.
- Do not treat session checkpoints as a replacement for commits and remote backups.

## Development

```sh
npm install
npm run check
```

## License

MIT
