/**
 * 飞书机器人服务：封装官方 SDK 的长连接与消息 API，注册为 `ctx.feishu`。
 *
 * 绑定 = appId/appSecret + WebSocket 长连接（免公网回调）；互动 =
 * 接收消息（`channel.on('message')`）+ 发送/回复消息 + 会话查询。
 *
 * @module dsh-feishu-bot/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type LarkChannel,
  type LarkChannelOptions,
  type PolicyConfig,
  type SendInput,
  type SendOptions,
  type SendResult,
  type WSConnectionStatus,
} from '@larksuiteoapi/node-sdk'

/** 入站消息策略（透传给官方 SDK 的 PolicyConfig）。 */
export interface FeishuPolicyConfig {
  /** 私聊模式：open（默认）/ allowlist（白名单）/ pair（仅双向）/ disabled（关闭私聊）。 */
  dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled'
  /** dmMode=allowlist/pair 时的用户 open_id 白名单。 */
  dmAllowlist?: string[]
  /** 群聊白名单（chat_id 列表）；不配置表示不限群。 */
  groupAllowlist?: string[]
  /** 群聊中是否必须 @机器人 才回复（默认 true）。 */
  requireMention?: boolean
  /** 是否响应 @所有人 的消息（默认 false）。 */
  respondToMentionAll?: boolean
}

/** FeishuService 构造选项。 */
export interface FeishuServiceOptions {
  appId: string
  appSecret: string
  /** 开放平台域名：feishu（默认，国内版）/ lark（国际版）。 */
  domain?: 'feishu' | 'lark'
  loggerLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  policy?: FeishuPolicyConfig
}

/** 一个可被机器人访问的会话摘要（feishu_list_chats 工具的输出）。 */
export interface FeishuChatSummary {
  chatId: string
  name?: string
  description?: string
  chatMode?: 'group' | 'p2p' | 'topic'
  memberCount?: number
  ownerId?: string
}

/** 会话内一条消息的摘要（feishu_get_messages 工具的输出）。 */
export interface FeishuMessageItem {
  messageId: string
  msgType: string
  /** 原始 content JSON 字符串（text 消息形如 {"text":"..."}）。 */
  content: string
  senderId?: string
  senderName?: string
  createTime?: number
}

const LOGGER_LEVELS: Record<string, LoggerLevel> = {
  fatal: LoggerLevel.fatal,
  error: LoggerLevel.error,
  warn: LoggerLevel.warn,
  info: LoggerLevel.info,
  debug: LoggerLevel.debug,
  trace: LoggerLevel.trace,
}

/**
 * 飞书机器人服务。构造即注册 `ctx.feishu`（随插件卸载自动注销），
 * 调用 {@link connect} 建立长连接。
 */
export class FeishuService extends Service {
  readonly channel: LarkChannel

  constructor(ctx: Context, options: FeishuServiceOptions) {
    super(ctx, 'feishu')
    const channelOptions: LarkChannelOptions = {
      appId: options.appId,
      appSecret: options.appSecret,
      transport: 'websocket',
      domain: options.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      loggerLevel: LOGGER_LEVELS[options.loggerLevel ?? 'info'] ?? LoggerLevel.info,
      // 入站安全：去重 + 忽略太久远的旧消息（重连回放时避免重复回复）。
      safety: {
        dedup: { ttl: 30_000 },
        staleMessageWindowMs: 60_000,
      },
      policy: options.policy as PolicyConfig | undefined,
      source: 'dsh-feishu-bot',
    }
    this.channel = createLarkChannel(channelOptions)
  }

  /** 建立 WebSocket 长连接（等待首次握手成功），SDK 内置自动重连。 */
  async connect(): Promise<void> {
    await this.channel.connect()
  }

  /** 主动断开长连接（插件卸载时调用）。 */
  async disconnect(): Promise<void> {
    await this.channel.disconnect()
  }

  /** 长连接当前状态快照。 */
  getConnectionStatus(): WSConnectionStatus | undefined {
    return this.channel.getConnectionStatus()
  }

  /** 机器人自身在飞书中的 open_id / 名称（连接就绪后可用）。 */
  getBotIdentity(): { openId: string; name?: string } | undefined {
    const identity = this.channel.botIdentity
    return identity ? { openId: identity.openId, name: identity.name } : undefined
  }

  /**
   * 向目标发送消息。`to` 支持 chat_id（oc_ 开头）、用户 open_id（ou_ 开头）、
   * union_id（on_ 开头）、邮箱或 user_id，SDK 按前缀自动推断 receive_id_type。
   */
  send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, input, opts)
  }

  /** 发送纯文本消息。 */
  sendText(to: string, text: string, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { text }, opts)
  }

  /** 发送 markdown 富文本消息。 */
  sendMarkdown(to: string, markdown: string, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { markdown }, opts)
  }

  /** 发送交互卡片（card JSON）。 */
  sendCard(to: string, card: object, opts?: SendOptions): Promise<SendResult> {
    return this.channel.send(to, { card }, opts)
  }

  /**
   * 回复指定消息（只需 message_id，无需 chat_id）。官方 reply 接口仅支持
   * text / post / interactive 等类型。
   */
  async replyText(messageId: string, text: string): Promise<{ messageId: string }> {
    const res = await this.channel.rawClient.im.v1.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: 'text' },
    })
    if (res.code !== 0) {
      throw new Error(`飞书回复消息失败: code=${res.code} msg=${res.msg ?? ''}`)
    }
    return { messageId: res.data?.message_id ?? messageId }
  }

  /** 列出机器人可访问的会话（飞书 im.v1.chat.list）。 */
  async listChats(pageSize = 50): Promise<FeishuChatSummary[]> {
    const res = await this.channel.rawClient.im.v1.chat.list({
      params: { page_size: Math.min(Math.max(pageSize, 1), 100), user_id_type: 'open_id' },
    })
    if (res.code !== 0) {
      throw new Error(`飞书拉取会话列表失败: code=${res.code} msg=${res.msg ?? ''}`)
    }
    const items: FeishuChatSummary[] = []
    for (const item of res.data?.items ?? []) {
      if (!item.chat_id) continue
      items.push({
        chatId: item.chat_id,
        name: item.name,
        description: item.description,
        chatMode: item.chat_mode,
        ownerId: item.owner_id,
      })
    }
    return items
  }

  /** 拉取某个会话最近的消息（飞书 im.v1.message.list，按创建时间倒序）。 */
  async listMessages(chatId: string, pageSize = 20): Promise<FeishuMessageItem[]> {
    const res = await this.channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: Math.min(Math.max(pageSize, 1), 50),
        sort_type: 'ByCreateTimeDesc',
      },
    })
    if (res.code !== 0) {
      throw new Error(`飞书拉取会话消息失败: code=${res.code} msg=${res.msg ?? ''}`)
    }
    const items: FeishuMessageItem[] = []
    for (const item of res.data?.items ?? []) {
      if (!item.message_id) continue
      items.push({
        messageId: item.message_id,
        msgType: item.msg_type ?? '',
        content: item.body?.content ?? '',
        senderId: item.sender?.id,
        senderName: item.sender?.sender_name,
        createTime: item.create_time ? Number(item.create_time) : undefined,
      })
    }
    return items
  }

  /** 查询会话详情。 */
  async getChatInfo(chatId: string): Promise<FeishuChatSummary> {
    const info = await this.channel.getChatInfo(chatId)
    return {
      chatId: info.chatId,
      name: info.name,
      description: info.description,
      chatMode: info.chatType,
      memberCount: info.memberCount,
      ownerId: info.ownerId,
    }
  }
}

export default FeishuService
