# pi-claude-rewind

为 [Pi](https://pi.dev) 提供类似 Claude Code 的“对话与工作区同步回退”。

Pi 本身已经有原生会话树。本扩展会把每条用户消息节点与一个独立的工作区快照精确绑定，因此选择历史对话时，可以让代码和对话一起回到当时的状态。

## 功能

- 双击 `Esc` 打开 Pi 原生会话树
- 每次发送用户提示词前自动建立 checkpoint
- 代码与对话一起回退
- 仅回退对话
- 仅恢复代码
- `/redo-rewind` 恢复到最近一次回退之前
- `/resume` 或重启 Pi 后仍可使用 checkpoint
- 通过 Pi 会话节点 `entryId` 精确绑定快照与用户消息
- 使用 `pi.appendEntry()` 将 checkpoint 元数据写进 Pi 会话树
- 使用独立 shadow Git，不修改项目 Git 的提交、分支、索引或 reflog
- 可记录未跟踪文件以及 Shell 命令产生的普通文件变化
- 拒绝通过符号链接或硬链接恢复，防止写穿链接
- 每个会话最多保留 100 个 checkpoint

## 要求

- Pi 0.85.1 或更高版本
- Node.js 22.19.0 或更高版本
- `PATH` 中可用的 Git

工作区本身不需要是 Git 仓库。

## 安装

npm 发布后：

```sh
pi install npm:pi-claude-rewind
```

在 npm 发布前，可以从 GitHub 安装：

```sh
pi install git:github.com/Wcowin/pi-claude-rewind
```

也可以安装本地目录：

```sh
pi install /absolute/path/to/pi-claude-rewind
```

## 推荐 Pi 设置

在 `~/.pi/agent/settings.json` 中加入以下设置，或者通过 `/settings` 配置：

```json
{
  "doubleEscapeAction": "tree",
  "treeFilterMode": "user-only",
  "branchSummary": {
    "skipPrompt": true
  }
}
```

- `doubleEscapeAction: "tree"`：双击 `Esc` 打开原生对话树。
- `treeFilterMode: "user-only"`：选择器只显示用户消息，更接近 Claude Code。
- `branchSummary.skipPrompt: true`：回退过程中不再额外询问是否生成分支摘要。

安装或修改设置后执行：

```text
/reload
```

## 使用方法

1. 正常使用 Pi。每条提示词执行前都会建立 checkpoint。
2. 清空输入框。
3. 连续按两次 `Esc`。
4. 选择一条历史用户消息。
5. 选择恢复方式：

```text
代码和对话一起回退（推荐）
仅回退对话
仅恢复代码（保持当前对话）
取消
```

选择用户消息后，Pi 原生会把对话叶节点移动到该消息的父节点，并把原提示词放回输入框；本扩展同时恢复绑定到该消息 `entryId` 的工作区快照。

### 命令

```text
/rewind-status   查看 checkpoint 数量和 redo 状态
/redo-rewind     恢复最近一次回退之前的代码和对话
```

## 工作原理

Pi 在当前用户消息写入会话之前触发 `before_agent_start`。扩展在这个事件中创建工作区快照，但暂不绑定消息 ID。随后，在 Pi 的 `context` 事件中，用户消息已经持久化并获得稳定的会话树 `entryId`，同时模型还没有开始修改文件；扩展就在这里把待处理快照绑定到真实 ID。

使用原生 `/tree` 导航时，`session_before_tree` 会提供选中的 `targetId`。扩展查找对应快照，先保存一个紧急 redo 点，再恢复工作区；只有恢复成功，才允许 Pi 继续回退对话。代码恢复失败会取消对话跳转。

快照保存在 Pi agent 目录下的独立 bare Git 对象库：

```text
<pi-agent-dir>/file-history/claude-rewind/<session-id>/
```

它不会修改项目的 `.git`、索引、当前分支、提交记录或 reflog。

## 安全与限制

- 只能恢复插件安装并加载之后建立的 checkpoint。
- 无法回退远程副作用，例如 API 请求、数据库写入、部署和已发送消息。
- `.git`、`node_modules`、`DerivedData`、`.build`、`Pods`、`Carthage/Build` 等构建或依赖目录不会进入快照。
- 符号链接、硬链接以及链接目录下的路径会被拒绝恢复。
- 扩展会扫描所有未排除的工作区文件；超大仓库可能需要更长时间和更多磁盘空间。
- Git 对象会按内容去重，但很长的会话仍然需要关注存储占用。
- 会话 checkpoint 不能代替正常的 Git 提交和远程备份。

## 开发

```sh
npm install
npm run check
```

## 许可证

MIT
