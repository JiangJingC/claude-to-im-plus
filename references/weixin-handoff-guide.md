# 微信 Handoff 使用指南

这份文档单独记录 `handoff` 的使用方式，重点回答两个问题：

1. 机器重启后，微信会不会继续连到之前的 Codex thread
2. 想切到别的 Codex thread 时，完整流程应该怎么走

## 适用场景

`handoff` 适合这样的工作流：

- 你正在 Codex 桌面端里工作
- 中途离开电脑，想改成在微信里继续当前会话
- 或者你想把微信聊天切到另一个已经存在的 Codex thread

`handoff` 的本质不是“复制对话内容”，而是“把某个微信聊天重新绑定到指定的 Codex thread”。

## 核心概念

- `sdkSessionId`
  - 就是 Codex 的 thread id
  - handoff 真正切换的是这个值
- `binding`
  - 表示某个 IM 聊天和本地 bridge session 的绑定关系
  - 微信每个聊天会有一条 binding
- `bridge session`
  - 本地桥接层记录
  - handoff 时会新建一条，不会删除旧记录

## 重启后的行为

### 1. thread 绑定会保留

handoff 成功后，目标微信聊天对应的 thread id 会写入：

- `~/.claude-to-im/data/bindings.json`
- `~/.claude-to-im/data/sessions.json`

所以只要这些文件还在，机器重启后，绑定关系不会丢。

### 2. 机器重启后不一定会自动启动 bridge

是否会自动启动，取决于本机的 `launchd` 配置。

当前 macOS 看的关键项是：

- `~/Library/LaunchAgents/com.claude-to-im.bridge.plist`
- 其中的 `RunAtLoad`

如果是：

- `RunAtLoad = true`
  - 登录后会自动拉起 bridge
- `RunAtLoad = false`
  - 登录后不会自动启动
  - 需要你手动执行一次 `claude-to-im start`

即使 bridge 没有自动启动，之前 handoff 到的 thread 绑定仍然保留。你启动 bridge 之后，微信下一条新消息会继续走那个 thread。

### 3. 微信扫码登录通常不会因为重启丢失

微信登录信息保存在：

- `~/.claude-to-im/data/weixin-accounts.json`
- `~/.claude-to-im/data/weixin-context-tokens.json`

正常情况下，系统重启不会要求重新扫码。只有在微信 token 失效或本地数据被清理时，才需要重新登录。

## 三种常用切换方式

### 方式一：切到当前桌面会话

如果你现在就在目标 Codex 会话里，最简单：

```text
claude-to-im handoff weixin
```

它会直接读取当前环境里的 `CODEX_THREAD_ID`，把微信切过去。

### 方式二：切到已知 thread id

如果你已经知道目标 thread id：

```text
claude-to-im handoff weixin <thread-id>
```

例如：

```text
claude-to-im handoff weixin 019d48c5-46f8-7d92-8e49-5c9d9fc164a0
```

### 方式三：先按项目列 thread，再选择切换

这适合你不记得 thread id，但知道它属于哪个项目目录。

## 完整流程：按项目目录列出 thread 再切换

### 第 1 步：创建项目配置

创建文件：

- `~/.claude-to-im/projects.json`

示例：

```json
{
  "projects": [
    {
      "id": "skill",
      "name": "Claude-to-IM Skill",
      "cwd": "/Users/yourname/path/to/project"
    },
    {
      "id": "kb",
      "name": "Knowledge Base",
      "cwd": "/Users/yourname/path/to/knowledge-base"
    }
  ]
}
```

规则：

- `id` 是你命令里使用的短别名
- `name` 只是展示名称
- `cwd` 必须是绝对路径
- 匹配规则是“路径规范化后严格相等”
- `/repo` 不会匹配 `/repo/subdir`

### 第 2 步：查看已配置项目

```text
claude-to-im handoff projects
```

这会列出 `projects.json` 里的所有项目。

### 第 3 步：列出某个项目下最近的 Codex thread

```text
claude-to-im handoff threads <project-id>
```

例如：

```text
claude-to-im handoff threads skill
```

也可以带数量限制：

```text
claude-to-im handoff threads skill 30
```

它会从本地 Codex 历史中读取：

- `~/.codex/session_index.jsonl`
- `~/.codex/sessions/**/*.jsonl`

然后列出 `session_meta.cwd` 与该项目 `cwd` 严格匹配的 thread。

### 第 4 步：把微信切到目标 thread

从上一步拿到 thread id 后执行：

```text
claude-to-im handoff weixin <thread-id>
```

## 多个微信聊天时怎么选

如果当前只有一个微信 binding，系统会自动选中。

如果有多个微信聊天 binding，命令会提示你传入 binding id 前缀。格式是：

```text
claude-to-im handoff weixin <thread-id> <binding-id-prefix>
```

例如：

```text
claude-to-im handoff weixin 019d48c5-46f8-7d92-8e49-5c9d9fc164a0 3fe039c5
```

## handoff 执行时实际发生了什么

当 bridge 正在运行时，`handoff weixin` 的行为是：

1. 先检查 bridge 是否在运行
2. 如果在运行，先停止 bridge
3. 更新 `bindings.json` 和 `sessions.json`
4. 如果刚才原本在运行，再重新启动 bridge
5. 最后输出状态

如果 bridge 原本没有运行：

- 只更新绑定
- 不会自动启动 bridge

## 重要限制

### 1. 只影响后续消息

handoff 不会把“当前正在生成中的这一轮回复”半路迁过去。

它只会影响之后从微信发进来的新消息。

### 2. 重启 bridge 会丢掉待处理的权限请求

如果正好有工具权限审批还没处理，handoff 触发的重启会让这类 pending request 失效。

### 3. 默认会清空 model pin

handoff 时会把 binding/session 的 `model` 设为空字符串，目的是避免恢复 thread 时出现 model mismatch。

### 4. 会保留旧 session

handoff 不会删除旧的 bridge session 和消息文件，只会新建一条新的 session 记录并更新 binding 指向。

## 推荐使用习惯

### 快速切到当前会话

适合你正在当前 Codex 对话里工作：

```text
claude-to-im handoff weixin
```

### 先查项目再切

适合你知道项目，但不记得 thread id：

```text
claude-to-im handoff projects
claude-to-im handoff threads skill
claude-to-im handoff weixin <thread-id>
```

### 系统重启后的恢复方式

如果你的机器重启后 bridge 没自动起来：

```text
claude-to-im start
```

然后直接去微信发下一条消息即可，绑定仍然会指向上一次 handoff 的 thread。

## 从微信回到桌面后如何恢复查看

如果你已经在微信里继续聊了一段时间，后来想回到 Codex 桌面端继续看同一条对话，需要注意：

- 不需要重新 handoff
- 不需要 fork 新 thread
- 不需要新建一条会话

正确做法是继续回到原来的那个 thread。

### 推荐恢复顺序

1. 先在 Codex 的历史列表里重新打开原 thread
2. 如果重新点开后仍然没有刷新，直接重启 Codex 应用
3. 重启后再打开原 thread，通常就能看到微信里新增的后续内容

### 为什么会这样

当前 bridge 会把微信里的新消息和回复继续写进同一个 Codex thread 文件。

但 Codex 桌面端对“已经打开中的 thread 视图”不一定会实时刷新，所以可能出现：

- 微信里已经继续聊了
- 本地 thread 文件也已经更新了
- 但桌面端当前打开的页面还停留在旧内容

这种情况下，问题通常不在 handoff，也不在 bridge，而在桌面端视图没有重新加载。

### 实际结论

- “切到微信”时才需要 handoff
- “从微信回电脑继续看同一条”通常不需要 handoff
- 如果点开原 thread 还是不刷新，重启 Codex 是目前最稳的恢复办法
