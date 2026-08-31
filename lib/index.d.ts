/**
 * dsh-feishu-bot — DeepSeek Harness 飞书（Feishu/Lark）机器人插件。
 *
 * 功能：
 * - 绑定：配置飞书自建应用的 appId/appSecret，通过官方 SDK 的 WebSocket
 *   长连接接入（免公网回调地址），SDK 内置自动重连；
 * - 互动（入站）：用户给机器人发消息 → 按 mode 处理
 *   （echo 回显 / llm 用 ctx.llm 自动回复 / agent 转交给 DSH agent 回复）；
 * - 互动（出站）：注册 feishu_* 模型工具，让 DSH agent 主动发消息、
 *   回复、查会话、查消息、查连接状态。
 *
 * 加载方式（profile 的 cordis.patch.yml）：
 * ```yaml
 * - id: feishu-bot
 *   name: dsh-feishu-bot
 *   config:
 *     appId: 'env:FEISHU_APP_ID'
 *     appSecret: 'env:FEISHU_APP_SECRET'
 *     mode: llm
 *     provider: deepseek-official
 *     model: deepseek-v4-flash
 * ```
 *
 * @module dsh-feishu-bot
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "feishu-bot";
export interface Config {
    /** 飞书自建应用的 App ID（cli_xxx）。支持 `env:VAR` 形式从环境变量读取。 */
    appId: string;
    /** 飞书自建应用的 App Secret。支持 `env:VAR` 形式从环境变量读取。 */
    appSecret: string;
    /** 开放平台域名：feishu（默认，国内版）/ lark（国际版）。 */
    domain?: 'feishu' | 'lark';
    /** SDK 日志级别。 */
    loggerLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    /** 私聊策略（见 {@link FeishuPolicyConfig}）。 */
    dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
    dmAllowlist?: string[];
    /** 群聊白名单（chat_id 列表）；不配置表示不限制。 */
    groupAllowlist?: string[];
    /** 群聊中是否必须 @机器人 才回复（默认 true）。 */
    requireMention?: boolean;
    /** 是否响应 @所有人 的消息（默认 false）。 */
    respondToMentionAll?: boolean;
    /**
     * 入站消息回复模式：
     * - `echo` 回显原文（验证绑定）；
     * - `llm` 用 ctx.llm 自动生成回复（默认）；
     * - `agent` 转交给 DSH agent 会话回复（指定 agentId 复用会话；
     *   不指定则每个飞书会话自动创建一个专属 agent）。
     */
    mode?: 'echo' | 'llm' | 'agent';
    /** llm 模式的系统提示词。 */
    systemPrompt?: string;
    /** llm 模式的 provider 路由（例如 deepseek-official）。 */
    provider?: string;
    /** llm 模式的模型 id。 */
    model?: string;
    /** llm 模式每会话保留的历史对话轮数（0 = 无记忆）。 */
    maxHistory?: number;
    /** agent 模式：转交的目标 agent（ctx.agents 中的会话 id）；不配置则自动创建。 */
    agentId?: string;
    /**
     * 自动创建的 agent 使用的 preset id（如 `standard` / `liangshen`）。
     * 不配置时跟随 GUI 设置的默认预设（agentPresets.defaultId）。
     */
    agentPreset?: string;
    /** agent 模式自动创建会话时的工作目录（默认 process.cwd()）。 */
    workspace?: string;
    /**
     * 是否启用飞书会话管理命令（默认 true，agent 模式生效）：
     * - `/new` `/reset`：清空当前飞书会话上下文（销毁专属 agent，下条消息新建）；
     * - `/sessions`：列出当前活跃的 DSH agent 会话；
     * - `/attach <会话id>`：接手 GUI 中某个既有会话（此后该飞书会话驱动它）；
     * - `/detach`：解除接手，回到自动创建模式。
     */
    commands?: boolean;
    /** 重置上下文命令列表（默认 ['/new', '/reset']）。 */
    resetCommands?: string[];
    /**
     * `/attach` 接手会话后，发送最近几条对话历史到飞书（0 = 不发，
     * 默认 5 条）。
     */
    attachHistory?: number;
    /**
     * 飞书目标群 chat_id（oc_ 开头）。配置后 `feishu_push` 工具可用：
     * 其他会话/定时任务的 agent 可把结果一键推送到该群。
     */
    pushChatId?: string;
    /** 是否注册模型可调用的 feishu_* 工具（默认 true）。 */
    tools?: boolean;
    /** 回复消息的排版格式：markdown（富文本渲染，默认）或 text（纯文本）。 */
    replyFormat?: 'markdown' | 'text';
}
export declare const Config: z<Config>;
/** 把 `env:VAR` 形式的配置值解析为环境变量值。 */
export declare function resolveSecret(raw: string): string;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map