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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FeishuService, type FeishuPolicyConfig } from './service.ts'
import { attachInbound } from './inbound.ts'
import { registerFeishuTools } from './tools.ts'

export const name = 'feishu-bot'

export interface Config {
  /** 飞书自建应用的 App ID（cli_xxx）。支持 `env:VAR` 形式从环境变量读取。 */
  appId: string
  /** 飞书自建应用的 App Secret。支持 `env:VAR` 形式从环境变量读取。 */
  appSecret: string
  /** 开放平台域名：feishu（默认，国内版）/ lark（国际版）。 */
  domain?: 'feishu' | 'lark'
  /** SDK 日志级别。 */
  loggerLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  /** 私聊策略（见 {@link FeishuPolicyConfig}）。 */
  dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled'
  dmAllowlist?: string[]
  /** 群聊白名单（chat_id 列表）；不配置表示不限制。 */
  groupAllowlist?: string[]
  /** 群聊中是否必须 @机器人 才回复（默认 true）。 */
  requireMention?: boolean
  /** 是否响应 @所有人 的消息（默认 false）。 */
  respondToMentionAll?: boolean
  /**
   * 入站消息回复模式：
   * - `echo` 回显原文（验证绑定）；
   * - `llm` 用 ctx.llm 自动生成回复（默认）；
   * - `agent` 转交给 DSH agent 会话回复（指定 agentId 复用会话；
   *   不指定则每个飞书会话自动创建一个专属 agent）。
   */
  mode?: 'echo' | 'llm' | 'agent'
  /** llm 模式的系统提示词。 */
  systemPrompt?: string
  /** llm 模式的 provider 路由（例如 deepseek-official）。 */
  provider?: string
  /** llm 模式的模型 id。 */
  model?: string
  /** llm 模式每会话保留的历史对话轮数（0 = 无记忆）。 */
  maxHistory?: number
  /** agent 模式：转交的目标 agent（ctx.agents 中的会话 id）；不配置则自动创建。 */
  agentId?: string
  /**
   * 自动创建的 agent 使用的 preset id（如 `standard` / `liangshen`）。
   * 不配置时跟随 GUI 设置的默认预设（agentPresets.defaultId）。
   */
  agentPreset?: string
  /** agent 模式自动创建会话时的工作目录（默认 process.cwd()）。 */
  workspace?: string
  /**
   * 是否启用飞书会话管理命令（默认 true，agent 模式生效）：
   * - `/new` `/reset`：清空当前飞书会话上下文（销毁专属 agent，下条消息新建）；
   * - `/sessions`：列出当前活跃的 DSH agent 会话；
   * - `/attach <会话id>`：接手 GUI 中某个既有会话（此后该飞书会话驱动它）；
   * - `/detach`：解除接手，回到自动创建模式。
   */
  commands?: boolean
  /** 重置上下文命令列表（默认 ['/new', '/reset']）。 */
  resetCommands?: string[]
  /**
   * `/attach` 接手会话后，发送最近几条对话历史到飞书（0 = 不发，
   * 默认 5 条）。
   */
  attachHistory?: number
  /** 是否注册模型可调用的 feishu_* 工具（默认 true）。 */
  tools?: boolean
}

export const Config: z<Config> = z.object({
  appId: z.string().required().description('飞书自建应用的 App ID（cli_xxx），支持 env:VAR 从环境变量读取'),
  appSecret: z.string().required().description('飞书自建应用的 App Secret，支持 env:VAR 从环境变量读取'),
  domain: z.union(['feishu', 'lark'] as const).default('feishu'),
  loggerLevel: z.union(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const).default('info'),
  dmMode: z.union(['open', 'allowlist', 'pair', 'disabled'] as const).default('open'),
  dmAllowlist: z.array(z.string()).default([]),
  groupAllowlist: z.array(z.string()).default([]),
  requireMention: z.boolean().default(true),
  respondToMentionAll: z.boolean().default(false),
  mode: z.union(['echo', 'llm', 'agent'] as const).default('llm'),
  systemPrompt: z.string().default(
    '你是部署在飞书上的智能助手。请用简洁、友好的中文回答用户的问题；'
    + '涉及代码时直接给出可运行的代码块。',
  ),
  provider: z.string(),
  model: z.string(),
  maxHistory: z.number().min(0).default(20),
  agentId: z.string(),
  agentPreset: z.string(),
  workspace: z.string(),
  commands: z.boolean().default(true),
  resetCommands: z.array(z.string()).default(['/new', '/reset']),
  attachHistory: z.number().min(0).default(5),
  tools: z.boolean().default(true),
})

/** 把 `env:VAR` 形式的配置值解析为环境变量值。 */
export function resolveSecret(raw: string): string {
  if (raw.startsWith('env:')) {
    const name = raw.slice(4)
    const value = process.env[name]
    if (value === undefined) {
      throw new Error(`feishu-bot: 环境变量 ${name} 未设置（配置项使用了 env: 引用）`)
    }
    return value
  }
  return raw
}

export function apply(ctx: Context, config: Config): void {
  const service = new FeishuService(ctx, {
    appId: resolveSecret(config.appId),
    appSecret: resolveSecret(config.appSecret),
    domain: config.domain,
    loggerLevel: config.loggerLevel,
    policy: {
      dmMode: config.dmMode,
      dmAllowlist: config.dmAllowlist,
      groupAllowlist: config.groupAllowlist,
      requireMention: config.requireMention,
      respondToMentionAll: config.respondToMentionAll,
    } satisfies FeishuPolicyConfig,
  })

  // 插件卸载时断开长连接。
  ctx.effect(() => {
    return () => {
      void service.disconnect().catch((error: unknown) => {
        ctx.logger.warn('feishu: 断开长连接失败', error)
      })
    }
  })

  // 建立长连接（SDK 自动重连；初始失败只记录日志，不阻断插件加载）。
  void service.connect()
    .then(() => {
      const identity = service.getBotIdentity()
      ctx.logger.info(`feishu: 长连接已就绪（机器人：${identity?.name ?? identity?.openId ?? 'unknown'}）`)
    })
    .catch((error: unknown) => {
      ctx.logger.error('feishu: 连接长连接失败，请检查 appId/appSecret 与网络（SDK 将自动重试）', error)
    })

  // 入站互动：飞书消息 → 机器人回复。
  attachInbound(ctx, service, config)

  // 出站互动：模型可调用 feishu_* 工具。
  if (config.tools !== false) {
    registerFeishuTools(ctx, service)
  }
}
