# pi-claude-rewind

为 [Pi](https://pi.dev) 提供类似 Claude Code 的“对话与工作区同步回退”。

Pi 本身已经有原生会话树。本扩展会把每条用户任务节点与执行该任务之前的工作区状态精确绑定，因此可以在历史恢复点之间切换，并让代码和对话回到同一时刻。

## 功能

- 双击 `Esc` 打开 Pi 原生会话树
- 每次发送用户提示词前自动建立 checkpoint
- 恢复代码和对话到同一个历史节点
- 仅切换对话，代码保持不变
- 仅恢复代码，对话保持不变
- `/redo-rewind` 撤销最近一次恢复操作
- `/resume` 或重启 Pi 后仍可使用 checkpoint
- 通过 Pi 会话节点 `entryId` 精确绑定快照与用户消息
- 使用 `pi.appendEntry()` 将 checkpoint 元数据写进 Pi 会话树
- 使用独立 shadow Git，不修改项目 Git 的提交、分支、索引或 reflog
- 可记录未跟踪文件以及 Shell 命令产生的普通文件变化
- 拒绝通过符号链接或硬链接恢复，防止写穿链接
- 每个会话最多保留 100 个 checkpoint
- 运行时中英文适配：中文系统显示中文，其他环境默认显示英文

## 语言

Rewind 每次被 Pi 加载时，按以下优先级选择界面语言：

1. 显式设置的 `PI_CLAUDE_REWIND_LOCALE`（`zh-CN` 或 `en`）
2. macOS“语言与地区”中的首选语言和区域
3. `LC_ALL`、`LC_MESSAGES`、`LANGUAGE` 或 `LANG`
4. 无法判断时默认英文

需要时可以显式覆盖：

```sh
PI_CLAUDE_REWIND_LOCALE=zh-CN pi
PI_CLAUDE_REWIND_LOCALE=en pi
```

修改环境变量后执行 `/reload`。状态栏的 `↶ Rewind` 保持语言中立。

## 要求

- Pi 0.85.1 或更高版本
- Node.js 22.19.0 或更高版本
- `PATH` 中可用的 Git

工作区本身不需要是 Git 仓库。

## 安装

从 npm 安装：

```sh
pi install npm:pi-claude-rewind
```

也可以从 GitHub 安装：

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
- `branchSummary.skipPrompt: true`：恢复过程中不再额外询问是否生成分支摘要。

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
恢复代码和对话（推荐）
仅切换对话（代码保持不变）
仅恢复代码（对话保持不变）
取消
```

确认窗口会显示“恢复到执行「所选任务」之前”。选择用户任务后，Pi 原生会把对话叶节点移动到该消息的父节点，并把原提示词放回输入框；本扩展同时恢复绑定到该消息 `entryId` 的工作区状态。

状态栏只显示 `↶ Rewind`，表示扩展已就绪，不再显示容易被误解为回退次数的累计数字。每个历史恢复点代表一条拥有对应代码状态的用户任务；执行恢复本身不会增加或减少恢复点。

### 命令

```text
/rewind-status   查看历史恢复点数量及最近一次恢复是否可撤销
/redo-rewind     撤销最近一次代码和对话恢复
```

## 工作原理

Pi 在当前用户消息写入会话之前触发 `before_agent_start`。扩展在这个事件中创建工作区快照，但暂不绑定消息 ID。随后，在 Pi 的 `context` 事件中，用户消息已经持久化并获得稳定的会话树 `entryId`，同时模型还没有开始修改文件；扩展就在这里把待处理快照绑定到真实 ID。

使用原生 `/tree` 导航时，`session_before_tree` 会提供选中的 `targetId`。扩展查找对应快照，先保存一个紧急撤销点，再恢复工作区；只有恢复成功，才允许 Pi 继续切换对话。代码恢复失败会取消对话跳转。

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
