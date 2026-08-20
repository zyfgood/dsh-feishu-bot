/**
 * 模型可调用的 feishu_* 工具：让 DSH agent 通过已绑定的机器人主动与
 * 飞书互动（发消息、回复、查会话、查消息、查连接状态）。
 *
 * 依赖 `ctx.tools`；未加载该服务时跳过注册并告警。
 *
 * @module dsh-feishu-bot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export function registerFeishuTools(ctx, service) {
    const tools = ctx.get('tools');
    if (!tools) {
        ctx.logger.warn('feishu: 当前环境未加载 ctx.tools，跳过 feishu_* 工具注册');
        return;
    }
    const register = (tool) => {
        ctx.effect(() => tools.register(tool));
    };
    // ── 发送消息 ──────────────────────────────────────────────
    register(defineTool({
        name: 'feishu_send_message',
        description: '以已绑定飞书机器人的身份向飞书会话发送一条消息。target 传 chat_id（oc_ 开头，发到群聊/单聊会话）或用户 open_id（ou_ 开头，私聊该用户）。可引用某条消息回复。',
        parameters: {
            target: {
                type: 'string',
                required: true,
                description: '目标会话 id：chat_id（oc_ 开头）或用户 open_id（ou_ 开头）',
            },
            content: { type: 'string', required: true, description: '要发送的文本内容' },
            as_markdown: {
                type: 'boolean',
                description: '是否以 markdown 富文本格式发送（默认 false，纯文本）',
            },
            reply_to: { type: 'string', description: '可选：要引用的消息 message_id（回复该消息）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sent: { type: 'boolean', required: true },
                    target: { type: 'string', required: true },
                    message_id: { type: 'string' },
                    detail: { type: 'string' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.sent
                        ? `已通过飞书机器人发送到 ${value.target}（message_id: ${value.message_id ?? 'n/a'}）`
                        : `发送失败：${value.detail ?? '未知错误'}`,
                }],
        },
        execute: async (args) => {
            try {
                const input = args.as_markdown ? { markdown: args.content } : { text: args.content };
                const opts = args.reply_to ? { replyTo: args.reply_to } : undefined;
                const result = await service.send(args.target, input, opts);
                return { sent: true, target: args.target, message_id: result.messageId };
            }
            catch (error) {
                return {
                    sent: false,
                    target: args.target,
                    detail: error instanceof Error ? error.message : String(error),
                };
            }
        },
    }));
    // ── 回复消息 ──────────────────────────────────────────────
    register(defineTool({
        name: 'feishu_reply_message',
        description: '以已绑定飞书机器人的身份回复某条飞书消息（按 message_id 引用，无需知道会话 id）。',
        parameters: {
            message_id: { type: 'string', required: true, description: '要回复的消息 message_id' },
            content: { type: 'string', required: true, description: '回复的文本内容' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sent: { type: 'boolean', required: true },
                    message_id: { type: 'string', required: true },
                    detail: { type: 'string' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.sent
                        ? `已回复飞书消息 ${value.message_id}`
                        : `回复失败：${value.detail ?? '未知错误'}`,
                }],
        },
        execute: async (args) => {
            try {
                const result = await service.replyText(args.message_id, args.content);
                return { sent: true, message_id: result.messageId };
            }
            catch (error) {
                return {
                    sent: false,
                    message_id: args.message_id,
                    detail: error instanceof Error ? error.message : String(error),
                };
            }
        },
    }));
    // ── 列出会话 ──────────────────────────────────────────────
    register(defineTool({
        name: 'feishu_list_chats',
        description: '列出已绑定飞书机器人可访问的会话（群聊与单聊），返回 chat_id、名称、类型等。',
        parameters: {
            page_size: { type: 'number', description: '每页数量，默认 50，最大 100' },
        },
        output: {
            schema: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        chat_id: { type: 'string', required: true },
                        name: { type: 'string' },
                        description: { type: 'string' },
                        chat_mode: { type: 'string' },
                        owner_id: { type: 'string' },
                    },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.length === 0
                        ? '机器人当前可访问的会话为空'
                        : `机器人可访问的会话（共 ${value.length} 个）：\n`
                            + value.map((chat) => `- ${chat.name ?? '(未命名)'} [${chat.chat_mode ?? '?'}] chat_id=${chat.chat_id}`).join('\n'),
                }],
        },
        execute: async (args) => {
            const chats = await service.listChats(args.page_size ?? 50);
            return chats.map((chat) => ({
                chat_id: chat.chatId,
                name: chat.name,
                description: chat.description,
                chat_mode: chat.chatMode,
                owner_id: chat.ownerId,
            }));
        },
    }));
    // ── 拉取会话消息 ──────────────────────────────────────────
    register(defineTool({
        name: 'feishu_get_messages',
        description: '拉取飞书某个会话最近的消息（按时间倒序），用于了解群聊/单聊的最新上下文。',
        parameters: {
            chat_id: { type: 'string', required: true, description: '目标会话 chat_id（oc_ 开头）' },
            page_size: { type: 'number', description: '拉取条数，默认 20，最大 50' },
        },
        output: {
            schema: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        message_id: { type: 'string', required: true },
                        msg_type: { type: 'string' },
                        content: { type: 'string' },
                        sender_id: { type: 'string' },
                        sender_name: { type: 'string' },
                        create_time: { type: 'number' },
                    },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.length === 0
                        ? `会话 ${args.chat_id} 暂无消息`
                        : `会话 ${args.chat_id} 最近 ${value.length} 条消息：\n`
                            + value.map((msg) => {
                                const sender = msg.sender_name ?? msg.sender_id ?? 'unknown';
                                const time = msg.create_time ? new Date(msg.create_time).toISOString() : '';
                                const body = msg.content ?? '';
                                return `- [${time}] ${sender}: ${body.slice(0, 200)}`;
                            }).join('\n'),
                }],
        },
        execute: async (args) => {
            const items = await service.listMessages(args.chat_id, args.page_size ?? 20);
            return items.map((item) => ({
                message_id: item.messageId,
                msg_type: item.msgType,
                content: item.content,
                sender_id: item.senderId,
                sender_name: item.senderName,
                create_time: item.createTime,
            }));
        },
    }));
    // ── 会话详情 ──────────────────────────────────────────────
    register(defineTool({
        name: 'feishu_get_chat_info',
        description: '查询飞书某个会话的详情（名称、类型、成员数、群主等）。',
        parameters: {
            chat_id: { type: 'string', required: true, description: '目标会话 chat_id（oc_ 开头）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    chat_id: { type: 'string', required: true },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    chat_mode: { type: 'string' },
                    member_count: { type: 'number' },
                    owner_id: { type: 'string' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: `会话 ${value.chat_id}：${value.name ?? '(未命名)'}`
                        + `（类型: ${value.chat_mode ?? '?'}，成员: ${value.member_count ?? '?'}）`,
                }],
        },
        execute: async (args) => {
            const chat = await service.getChatInfo(args.chat_id);
            return {
                chat_id: chat.chatId,
                name: chat.name,
                description: chat.description,
                chat_mode: chat.chatMode,
                member_count: chat.memberCount,
                owner_id: chat.ownerId,
            };
        },
    }));
    // ── 连接状态 ──────────────────────────────────────────────
    register(defineTool({
        name: 'feishu_connection_status',
        description: '查询已绑定飞书机器人的长连接状态（connected/reconnecting 等）与机器人身份，用于诊断绑定是否生效。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    state: { type: 'string', required: true },
                    reconnect_attempts: { type: 'number' },
                    last_connect_time: { type: 'number' },
                    bot_open_id: { type: 'string' },
                    bot_name: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `飞书机器人长连接状态：${value.state}`
                        + `（机器人: ${value.bot_name ?? '未知'}，重连次数: ${value.reconnect_attempts ?? 0}）`,
                }],
        },
        execute: async () => {
            const status = service.getConnectionStatus();
            const identity = service.getBotIdentity();
            return {
                state: status?.state ?? 'unknown',
                reconnect_attempts: status?.reconnectAttempts ?? 0,
                last_connect_time: status?.lastConnectTime,
                bot_open_id: identity?.openId,
                bot_name: identity?.name,
            };
        },
    }));
}
//# sourceMappingURL=tools.js.map