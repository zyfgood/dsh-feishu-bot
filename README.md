# dsh-feishu-bot

DeepSeek Harness（DSH）插件：**绑定飞书（Feishu / Lark）机器人并互动**。

- **绑定**：配置飞书自建应用的 `appId` / `appSecret`，通过官方 SDK
  [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)
  的 **WebSocket 长连接**接入（**无需公网回调地址**），SDK 内置自动重连。
- **互动（入站）**：用户给机器人发消息 → 机器人自动回复，三种模式：
  - `echo`：回显原文（快速验证绑定是否打通）；
  - `llm`：调用 DSH 的 `ctx.llm` 服务直接生成回复（自包含，带每会话短期记忆）；
  - `agent`：把消息转交给 DSH agent 处理——指定 `agentId` 复用该会话，或自动为
    每个飞书会话创建一个专属 agent（**标准模式 preset**、持续复用上下文、
    具备全部 DSH 工具），agent 输出**流式实时转发**到飞书。
- **任务执行中提问**：agent 正在跑任务时发消息，会用 `steer` 在下一个节点
  插入你的问题，agent 先回应（流式实时到达）再继续任务。
- **互动（出站）**：注册 6 个模型可调用的 `feishu_*` 工具，让 DSH agent 主动
  与飞书互动（发消息、回复消息、查会话、查消息、查连接状态）。
- **策略**：群聊 @机器人 才回复、私聊开关、会话白名单、@所有人 响应开关，均由
  SDK 的入站策略管道执行。

---

## English Summary

**dsh-feishu-bot** bridges a [Feishu / Lark](https://open.feishu.cn/) bot into
DeepSeek Harness (DSH). Talk to your DSH agent from Feishu on your phone — no
public callback URL needed (official WebSocket long connection, auto-reconnect).

**Features**

- **Inbound (user → agent)**: three reply modes — `echo` (verify binding),
  `llm` (direct model reply with per-chat short-term memory), `agent` (hand the
  message to a DSH agent; auto-creates a dedicated per-chat session with the
  standard preset and full DSH tooling, replies **streamed live** to Feishu).
- **Ask while a task is running**: messages sent mid-task are injected via
  `steer` at the next step boundary — the agent answers first (streamed), then
  continues the task.
- **Session commands**: `/new` (fresh context), `/sessions` (list sessions),
  `/attach` (take over an existing GUI session — both sides share context),
  `/detach`.
- **Outbound (agent → Feishu)**: six model-callable tools
  (`feishu_send_message`, `feishu_reply_message`, `feishu_list_chats`,
  `feishu_get_messages`, `feishu_get_chat_info`, `feishu_connection_status`).
- **Policies**: group chats reply only when mentioned, DM on/off, chat
  allowlists, respond-to-@all switch — all via the SDK inbound policy pipeline.
- **Config**: `appId`/`appSecret` via `env:VAR` (never plaintext), `domain`
  `feishu`/`lark`, `dmMode` open/allowlist/pair/disabled, group allowlist,
  `requireMention`, agent preset & workspace, command toggles.

**Install**

```bash
# Git channel (repo root is the plugin)
dsh plugin --profile web add "github:zyfgood/dsh-feishu-bot#main&path:/"
# (npm channel: TBD)
```

Then create a self-built Feishu app (see the Chinese sections below for the
open-platform steps: bot capability, `im:message` scopes, subscribe
`im.message.receive_v1`, long-connection mode, publish a version) and restart
`dsh web`. Log line `feishu: 长连接已就绪（机器人：<bot name>）` means the
binding succeeded.

**License**: MIT.

---

## 目录

- [快速开始](#快速开始)
- [一、飞书开放平台：创建并配置机器人](#一飞书开放平台创建并配置机器人)
- [二、安装插件并加载](#二安装插件并加载)
- [三、配置项](#三配置项)
- [四、互动方式](#四互动方式)
- [五、常见问题](#五常见问题)

---

## 快速开始

1. 按[第一节](#一飞书开放平台创建并配置机器人)在飞书开放平台创建自建应用并发布版本；
2. 把插件装入 profile 并配置（见[第二节](#二安装插件并加载)，示例见 `cordis.patch.example.yml`）；
3. 重启 `dsh web`。

日志出现 `feishu: 长连接已就绪（机器人：<你的机器人名>）` 即绑定成功；在飞书里
给机器人发消息即可指挥 agent 工作（群聊需 @机器人，私聊直接发），让 DSH agent 调用
`feishu_connection_status` 可随时查看连接状态。

> 飞书开放平台侧有一个关键开关：**事件与回调 → 订阅方式 = 「使用长连接接收事件/回调」**
> （长连接模式无需配置请求地址）。若当前是回调 URL 模式，请切换为长连接，否则消息事件不会推过来。

---

## 一、飞书开放平台：创建并配置机器人

以下步骤在 [飞书开放平台](https://open.feishu.cn/)（国际版 [Lark](https://open.larksuite.com/)）
开发者后台完成，全程无需服务器公网地址。

1. **创建企业自建应用**
   「开发者后台」→「创建企业自建应用」，填写名称等信息。
2. **获取凭证**
   「凭证与基础信息」→ 复制 **App ID**（`cli_xxx`）与 **App Secret**。
3. **开启机器人能力**
   「添加应用能力」→ 勾选 **机器人**。
4. **添加权限**（「权限管理」→ 开通以下权限，保存后需发布版本生效）：
   | 权限 | 用途 |
   |---|---|
   | `im:message:send_as_bot` | 以机器人身份发送/回复消息 |
   | `im:message`（含 `p2p_msg` / `group_msg` / `group_at_msg` 子权限） | 接收用户消息事件 |
   | `im:chat:readonly`（可选） | 查询会话详情/列表 |
5. **订阅事件**（「事件与回调」→「事件配置」→「添加事件」）：
   添加 **接收消息 `im.message.receive_v1`**。
   > 使用长连接时**不需要配置回调请求地址**（Request URL 留空即可），
   > 事件会通过 WebSocket 长连接直接推给插件。
6. **发布版本**（「版本管理与发布」→ 创建版本 → 申请发布/审核通过）。
   自建应用只有发布后才能被用户搜到并使用。

## 二、安装插件并加载

插件以 Cordis 插件形式加载，通过 profile 的 `cordis.patch.yml` 插入配置行。

> **从 Git 仓库安装（推荐，一条命令安装并挂载）**
>
> ```bash
> # 安装前设置密钥环境变量（也可装后再设，重启前配置好即可）
> export FEISHU_APP_ID=cli_xxx
> export FEISHU_APP_SECRET=xxx
>
> dsh plugin --profile web add "github:zyfgood/dsh-feishu-bot#main&path:/"
> # 或 npm 渠道（发布后可用）：dsh plugin --profile web add dsh-feishu-bot
> ```
>
> 包内自带 `cordis.patch.yml`（`dsh.bundle.patch`），CLI 安装时自动挂载，
> 无需手工编辑配置文件；默认 `llm` 模式，改 `agent` 模式等见「三、配置项」，
> 在 profile 自己的 `cordis.patch.yml` 里按 `id: feishu-bot` 覆盖即可。
> 装完重启 `dsh web` 生效；下方是手工安装方式（适用于任何托管位置）。

### 2.1 把插件放进 profile 目录并安装依赖

DSH 的 profile 位于 Harness 家目录（`$DSH_HOME`，默认 `~/.dsh`）下的 `profiles/<name>/`。
以 `web` profile 为例：

```bash
# 1) 把本插件目录复制到 profile 目录（或放到任意位置后用 file: 引用）
cp -r /path/to/dsh-feishu-bot ~/.dsh/profiles/web/dsh-feishu-bot

# 2) 在 profile 的 package.json 中声明依赖并安装
cd ~/.dsh/profiles/web
# 若 profile 目录还没有 package.json，先创建（或直接执行下面的 pnpm add）
pnpm add ./dsh-feishu-bot
```

> 插件运行期还需要能解析 `@deepseek-ai/*` 与 `@larksuiteoapi/node-sdk`。
> DSH 会通过 profile 的 `node_modules` 与自身安装树自动解析 `@deepseek-ai/*`；
> `@larksuiteoapi/node-sdk` 由本插件自带的 `dependencies` 提供。

### 2.2 在 cordis.patch.yml 中加载插件

编辑 profile 的 `cordis.patch.yml`（`web` profile 为 `~/.dsh/profiles/web/cordis.patch.yml`），
追加：

```yaml
- id: feishu-bot
  name: dsh-feishu-bot
  config:
    appId: 'env:FEISHU_APP_ID'
    appSecret: 'env:FEISHU_APP_SECRET'
    mode: llm
    provider: deepseek-official
    model: deepseek-v4-flash
    requireMention: true
    tools: true
```

把 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 写入启动环境（如 `.env`、系统环境变量），
**不要在配置里明文写 App Secret**（插件支持 `env:VAR` 形式从环境变量读取）。

### 2.3 启动并验证

```bash
dsh --profile web
```

- 日志出现 `feishu: 长连接已就绪（机器人：xxx）` 即绑定成功。
- 在飞书里给机器人发一条私聊消息，`echo` 模式会回显 `收到：...`。
- 让 DSH agent 调用 `feishu_connection_status` 工具可随时查看连接状态。

## 三、配置项

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | string，必填 | — | 飞书自建应用 App ID（`cli_xxx`），支持 `env:VAR` |
| `appSecret` | string，必填 | — | 飞书自建应用 App Secret，支持 `env:VAR` |
| `domain` | `feishu` \| `lark` | `feishu` | 开放平台域名（国际版选 `lark`） |
| `loggerLevel` | `fatal`~`trace` | `info` | SDK 日志级别 |
| `dmMode` | `open` \| `allowlist` \| `pair` \| `disabled` | `open` | 私聊策略：开放/白名单/仅双向/关闭 |
| `dmAllowlist` | string[] | `[]` | `allowlist`/`pair` 模式下的用户 open_id 白名单 |
| `groupAllowlist` | string[] | `[]` | 群聊 chat_id 白名单（空 = 不限群） |
| `requireMention` | boolean | `true` | 群聊中必须 @机器人 才回复 |
| `respondToMentionAll` | boolean | `false` | 是否响应 @所有人 |
| `mode` | `echo` \| `llm` \| `agent` | `llm` | 入站回复模式 |
| `replyFormat` | `markdown` \| `text` | `markdown` | 回复排版：markdown 富文本（代码块/表格/列表完整渲染，agent 流式以卡片呈现）或纯文本 |
| `systemPrompt` | string | 默认提示词 | `llm` 模式的系统提示词 |
| `provider` | string | — | `llm` 模式的 provider 路由（如 `deepseek-official`） |
| `model` | string | — | `llm` 模式的模型 id（如 `deepseek-v4-flash`） |
| `maxHistory` | number | `20` | `llm` 模式每会话保留的对话轮数（0 = 无记忆） |
| `agentId` | string | — | `agent` 模式：目标 DSH agent 会话 id（不配置则自动创建） |
| `agentPreset` | string | 跟随默认 | 自动创建会话使用的 agent preset（如 `standard` / `liangshen`）；不配置跟随 GUI 默认预设 |
| `workspace` | string | `process.cwd()` | `agent` 模式自动创建会话时的工作目录 |
| `commands` | boolean | `true` | 是否启用飞书会话管理命令（`/new` `/sessions` `/attach` `/detach` `/cancel`） |
| `resetCommands` | string[] | `['/new', '/reset']` | 重置上下文命令列表 |
| `attachHistory` | number | `5` | /attach 接手后发送最近几条对话历史（0 = 不发） |
| `questionTimeoutMs` | number | `600000` | 飞书侧确认问题等待回答的超时（ms，默认 10 分钟；超时自动取消该次询问，防止 agent 回合/会话队列被永久挂起） |
| `persistSessions` | boolean | `true` | 是否持久化 chat→会话映射：dsh web 重启后自动 `resume` 原 DSH 会话，延续对话上下文（映射存于 `$DSH_HOME/feishu-bot/chat-sessions.json`） |
| `tools` | boolean | `true` | 是否注册 `feishu_*` 模型工具 |
| `pushChatId` | string | — | 飞书目标群 chat_id（`oc_` 开头）；配置后启用 `feishu_push` 工具（任务结果/定时推送直达该群） |

## 四、互动方式

### 4.1 入站：用户 → 机器人

- **`llm` 模式（默认）**：用户发消息 → 插件用 `ctx.llm` 生成回复并引用回复该消息。
  每个会话（chat_id）维护短期记忆（`maxHistory` 轮）。
- **`agent` 模式**：把消息作为 `user` 消息 `followup` 给 DSH agent 会话，agent 的
  输出（`assistant/chunk`）**流式实时转发**到飞书：首选**原生卡片流式**（cardkit
  打字机效果，只传增量，不再每次刷新把全文重传/重渲染）；卡片流式不可用时自动
  降级为「先发一条消息，随后持续编辑更新（约 400ms 聚合一次）」的旧链路，
  最终定型为完整回复。两种用法：
  - **自动创建**（推荐，不配置 `agentId`）：每个飞书会话首次消息时自动创建一个
    专属 DSH agent（**标准模式**：挂载 `agentPreset`（默认 `standard`），与 GUI
    新建会话一致；工作目录 = `workspace`，默认 `process.cwd()`），后续消息
    复用同一会话（上下文持续），agent 具备全部 DSH 工具能力，插件卸载时自动销毁；
  - **复用指定会话**（配置 `agentId`）：

  ```yaml
  - id: feishu-bot
    name: dsh-feishu-bot
    config:
      appId: 'env:FEISHU_APP_ID'
      appSecret: 'env:FEISHU_APP_SECRET'
      mode: agent
      agentId: main
  ```

  其中 `agentId` 是 `ctx.agents` 中存在的会话 id（例如 profile 里 `agent-spine`
  配置创建的 `main`，或 GUI 中当前会话的 id）。
- **`echo` 模式**：回显原文，适合先验证绑定是否打通。

### 4.2 任务执行中提问（agent 模式）

当 agent 正在执行任务（例如 GUI 里跑一个长任务、或上一轮回复还在进行）时，
你在飞书发消息：

- 插件改用 **`agent.steer()`** 把问题插入下一个 step 边界——agent 会在任务的
  下一个节点**先回应你的问题**，再继续任务（不会打断/丢弃任务）；
- 回应同样**流式实时转发**到飞书，遇到 agent 下一次工具调用即收尾定型；
- 若 agent 直接完成任务而没有再回应，则以 idle 收尾。
- 长任务期间你的消息会先收到「📥 已收到」即时确认，不再石沉大海。

> 说明：如果 agent 卡在单个长工具调用内（如长时间 bash 命令），问题要等该
> 工具返回后才能被读到——这是单 agent 模型的固有限制。

### 4.3 交互确认卡片（agent 调用 ask_user_question 时）

agent 在飞书会话里调用 `ask_user_question`（需要你确认/选择）时，**问题不再
只出现在 Web 界面**：插件会向该飞书会话发送一张**带按钮的交互卡片**（每个选项
一个按钮）+ 编号提示，你可以：

- **点按钮**直接选择；
- 或**回复编号**（如 `1`、`2,3`；多选问题用逗号分隔）或**回复选项原文**；
- 或回复 `/cancel` 取消该次询问（agent 继续执行、不等待）。

超时（`questionTimeoutMs`，默认 10 分钟）未回答会自动取消该次询问，agent 回合
必然结束——不会出现「问题只出现在 Web、飞书侧永久挂起、机器人从此不再回复」。
（`/attach` 接手的 GUI 会话不受影响，确认仍走 Web 界面。）

### 4.4 飞书会话管理命令（agent 模式，`commands` 默认开启）

在飞书里直接给机器人发命令（群聊需 @机器人），无需改配置、无需重启：

| 命令 | 作用 |
|---|---|
| `/new` 或 `/reset` | **开始新会话**：销毁当前飞书会话的专属 agent，下一条消息自动新建（上下文清空） |
| `/sessions` | 列出当前活跃的 DSH agent 会话（编号 + 标题 + 模型 + 工作目录） |
| `/attach <编号或会话id>` | **接手 GUI 中某个既有会话**：此后该飞书会话直接驱动它（两边共享上下文，GUI 可见） |
| `/detach` | 解除接手，回到自动创建模式 |
| `/cancel` | 取消当前待确认问题（agent 继续执行） |

示例：想在飞书里继续 GUI 中某个会话 → 先发 `/sessions`，看到类似：

```
当前活跃会话（2 个）：
💬 1. 帮我重构登录模块
    id=session-gui-777 · deepseek-v4-pro · /workspace/projA
🤖飞书 2. 飞书会话 · DSHProjects
    id=feishu-oc_xxx-1234abcd · deepseek-v4-flash · /workspace

用 /attach <编号或会话id> 接手（编号见上），/detach 解除。
```

再发 `/attach 1`（按编号）或 `/attach session-gui-777`（按 id）即可接手；
想清空上下文重新开始 → 发 `/new`。

> 说明：`/new` 只销毁**插件自动创建**的专属会话；`/attach` 接手的 GUI 会话
> 不会被销毁（用 `/detach` 解除）。命令可通过 `commands: false` 关闭，
> 重置命令可通过 `resetCommands` 自定义（默认 `['/new', '/reset']`）。
>
> 自动创建的飞书会话会**自动归入 `workspace` 配置的工作区**（如 DSHProjects），
> 不会出现在「未分组」里；会话标题由 DSH 的 session-title 服务生成，未生成前
> 显示「飞书会话 · <目录名>」。
>
> **重启延续**（`persistSessions`，默认开启）：插件把 chat→会话 映射持久化到
> `$DSH_HOME/feishu-bot/chat-sessions.json`。dsh web 重启/插件重载后，你在
> 飞书发的下一条消息会自动 `resume` 原 DSH 会话（同一 id、同一上下文），
> 不会再被当成新用户另起炉灶。`/new` 会清除该映射。

### 4.5 出站：DSH agent → 飞书（模型工具）

| 工具 | 用途 |
|---|---|
| `feishu_send_message` | 向会话/用户发送文本或 markdown，可引用某条消息回复 |
| `feishu_send_card` | 向会话/用户发送**任意交互卡片**（卡片 JSON 2.0，可带按钮等元素） |
| `feishu_ask_choice` | 发送**带按钮的确认卡片**并等待用户点击（或回复编号/选项文字）；超时可配，返回 `timeout=true` |
| `feishu_reply_message` | 按 message_id 回复某条消息（无需知道会话 id） |
| `feishu_list_chats` | 列出机器人可访问的会话 |
| `feishu_get_messages` | 拉取某会话最近消息（了解上下文） |
| `feishu_get_chat_info` | 查询会话详情 |
| `feishu_connection_status` | 查询长连接状态与机器人身份（诊断用） |
| `feishu_push` | 把结果一键推送到配置的目标群（需 `pushChatId`；适合任务汇报、定时任务推送） |

`feishu_send_message` 的 `target` 支持 chat_id（`oc_` 开头）或用户 open_id（`ou_` 开头），
SDK 按前缀自动推断接收方类型。按钮卡片（`feishu_ask_choice` / 确认卡片）需要
开放平台已订阅**卡片交互回调**（长连接模式下在「事件与回调 → 事件订阅」勾选
`card.action.trigger`），点击事件才会推送到插件。

## 五、常见问题

- **安装报 `ERR_PNPM_IGNORED_BUILDS`（protobufjs）**：pnpm 10/11 默认拦截依赖构建脚本，
  `@larksuiteoapi/node-sdk` 的传递依赖 protobufjs 需要放行。在 profile 的
  `pnpm-workspace.yaml` 加入：

  ```yaml
  allowBuilds:
    protobufjs: true
  ```

  然后重新执行安装命令即可。
- **`feishu: 连接长连接失败`（code 10003 invalid param）**：appId/appSecret 无效，
  或应用未发布版本。检查凭证与「版本管理与发布」状态。
- **群聊里机器人不回复**：确认已开启机器人能力、已订阅 `im.message.receive_v1`、
  已发布版本，且群聊中消息是 **@机器人** 发送的（`requireMention: true`）。
- **权限错误（permission denied）**：在开放平台补充 `im:message:send_as_bot` /
  `im:message` 等权限后需**重新发布版本**。
- **私聊不可用**：`dmMode` 默认 `open`；若设为 `disabled` 则机器人不响应私聊。
- **agent 模式无回复**：确认 `agentId` 对应会话在 `ctx.agents` 中处于活跃状态；
  若 agent 只调用工具而未输出文本，插件不会发送空消息。
- **对话一轮就断 / 机器人不再回复**：旧版本在 agent 调用 `ask_user_question`（需你
  确认）时，问题只出现在 Web 界面，飞书侧答不了，agent 回合永久挂起导致该会话
  队列被堵死。升级到 v0.6.0 后问题会以交互卡片发到飞书（点按钮/回编号/`/cancel`），
  并有超时兜底；若仍怀疑卡住，可在飞书发 `/new` 重置会话。
- **重启后飞书对话上下文丢失**：v0.6.0 起默认持久化 chat→会话映射并自动恢复；
  确认 `persistSessions` 未被关闭、`$DSH_HOME/feishu-bot/chat-sessions.json` 可写。
- **卡片按钮点击无响应**：开放平台需已订阅**卡片交互回调**（长连接模式下在
  「事件与回调 → 事件订阅」勾选 `card.action.trigger`）并重新发布版本。

## 开发与构建

```bash
npm install --legacy-peer-deps   # 安装依赖（@deepseek-ai/* 由 DSH 运行期提供，这里仅用于类型检查）
npm run build                    # tsc 构建到 lib/
npm test                         # 冒烟测试（mock 上下文跑通核心链路，无需真实飞书凭证）
```

> 仓库中的 `lib/` 为已构建产物（开箱即用）；修改 `src/` 后运行 `npm run build` 重新生成。

源码结构：

- `src/index.ts` — 插件入口（Config 校验、服务注册、生命周期）
- `src/service.ts` — `FeishuService`（`ctx.feishu`：长连接 + 消息 API）
- `src/inbound.ts` — 入站消息路由（echo / llm / agent）+ 会话管理命令 + 会话恢复
- `src/questions.ts` — 飞书侧确认问答（交互卡片 + 按钮点击 + 文本回答 + 超时兜底）
- `src/persistence.ts` — chat→会话映射落盘（重启后 resume 恢复上下文）
- `src/tools.ts` — 模型可调用的 `feishu_*` 工具
- `tests/smoke.mjs` — 冒烟测试（`npm test`）
- `cordis.patch.example.yml` — profile patch 配置示例

## License

MIT
