/**
 * 飞书机器人服务：封装官方 SDK 的长连接与消息 API，注册为 `ctx.feishu`。
 *
 * 绑定 = appId/appSecret + WebSocket 长连接（免公网回调）；互动 =
 * 接收消息（`channel.on('message')`）+ 发送/回复消息 + 会话查询。
 *
 * @module dsh-feishu-bot/service
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type LarkChannel, type SendInput, type SendOptions, type SendResult, type WSConnectionStatus } from '@larksuiteoapi/node-sdk';
/** 入站消息策略（透传给官方 SDK 的 PolicyConfig）。 */
export interface FeishuPolicyConfig {
    /** 私聊模式：open（默认）/ allowlist（白名单）/ pair（仅双向）/ disabled（关闭私聊）。 */
    dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
    /** dmMode=allowlist/pair 时的用户 open_id 白名单。 */
    dmAllowlist?: string[];
    /** 群聊白名单（chat_id 列表）；不配置表示不限群。 */
    groupAllowlist?: string[];
    /** 群聊中是否必须 @机器人 才回复（默认 true）。 */
    requireMention?: boolean;
    /** 是否响应 @所有人 的消息（默认 false）。 */
    respondToMentionAll?: boolean;
}
/** FeishuService 构造选项。 */
export interface FeishuServiceOptions {
    appId: string;
    appSecret: string;
    /** 开放平台域名：feishu（默认，国内版）/ lark（国际版）。 */
    domain?: 'feishu' | 'lark';
    loggerLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    policy?: FeishuPolicyConfig;
}
/** 一个可被机器人访问的会话摘要（feishu_list_chats 工具的输出）。 */
export interface FeishuChatSummary {
    chatId: string;
    name?: string;
    description?: string;
    chatMode?: 'group' | 'p2p' | 'topic';
    memberCount?: number;
    ownerId?: string;
}
/** 会话内一条消息的摘要（feishu_get_messages 工具的输出）。 */
export interface FeishuMessageItem {
    messageId: string;
    msgType: string;
    /** 原始 content JSON 字符串（text 消息形如 {"text":"..."}）。 */
    content: string;
    senderId?: string;
    senderName?: string;
    createTime?: number;
}
/**
 * 飞书机器人服务。构造即注册 `ctx.feishu`（随插件卸载自动注销），
 * 调用 {@link connect} 建立长连接。
 */
export declare class FeishuService extends Service {
    readonly channel: LarkChannel;
    constructor(ctx: Context, options: FeishuServiceOptions);
    /** 建立 WebSocket 长连接（等待首次握手成功），SDK 内置自动重连。 */
    connect(): Promise<void>;
    /** 主动断开长连接（插件卸载时调用）。 */
    disconnect(): Promise<void>;
    /** 长连接当前状态快照。 */
    getConnectionStatus(): WSConnectionStatus | undefined;
    /** 机器人自身在飞书中的 open_id / 名称（连接就绪后可用）。 */
    getBotIdentity(): {
        openId: string;
        name?: string;
    } | undefined;
    /**
     * 向目标发送消息。`to` 支持 chat_id（oc_ 开头）、用户 open_id（ou_ 开头）、
     * union_id（on_ 开头）、邮箱或 user_id，SDK 按前缀自动推断 receive_id_type。
     */
    send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>;
    /** 发送纯文本消息。 */
    sendText(to: string, text: string, opts?: SendOptions): Promise<SendResult>;
    /** 发送 markdown 富文本消息。 */
    sendMarkdown(to: string, markdown: string, opts?: SendOptions): Promise<SendResult>;
    /** 发送交互卡片（card JSON）。 */
    sendCard(to: string, card: object, opts?: SendOptions): Promise<SendResult>;
    /** 发送 markdown 卡片：card v2 的 markdown 元素，完整渲染代码块/表格/列表。 */
    sendMarkdownCard(to: string, markdown: string, opts?: SendOptions): Promise<SendResult>;
    /** 更新已发送 markdown 卡片的内容（流式刷新用，需卡片的 update_multi 已开）。 */
    updateMarkdownCard(messageId: string, markdown: string): Promise<void>;
    /**
     * 回复指定消息（只需 message_id，无需 chat_id）。官方 reply 接口仅支持
     * text / post / interactive 等类型。
     */
    replyText(messageId: string, text: string): Promise<{
        messageId: string;
    }>;
    /** 列出机器人可访问的会话（飞书 im.v1.chat.list）。 */
    listChats(pageSize?: number): Promise<FeishuChatSummary[]>;
    /** 拉取某个会话最近的消息（飞书 im.v1.message.list，按创建时间倒序）。 */
    listMessages(chatId: string, pageSize?: number): Promise<FeishuMessageItem[]>;
    /** 查询会话详情。 */
    getChatInfo(chatId: string): Promise<FeishuChatSummary>;
}
/** 构造「单个 markdown 元素」的 card v2 结构（update_multi 允许流式多次更新）。 */
export declare function markdownCard(markdown: string): object;
export default FeishuService;
//# sourceMappingURL=service.d.ts.map