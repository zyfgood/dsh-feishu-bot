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
import z from '@deepseek-ai/schemastery';
import { FeishuService } from "./service.js";
import { attachInbound } from "./inbound.js";
import { registerFeishuTools } from "./tools.js";
export const name = 'feishu-bot';
export const Config = z.object({
    appId: z.string().required().description('飞书自建应用的 App ID（cli_xxx），支持 env:VAR 从环境变量读取'),
    appSecret: z.string().required().description('飞书自建应用的 App Secret，支持 env:VAR 从环境变量读取'),
    domain: z.union(['feishu', 'lark']).default('feishu'),
    loggerLevel: z.union(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    dmMode: z.union(['open', 'allowlist', 'pair', 'disabled']).default('open'),
    dmAllowlist: z.array(z.string()).default([]),
    groupAllowlist: z.array(z.string()).default([]),
    requireMention: z.boolean().default(true),
    respondToMentionAll: z.boolean().default(false),
    mode: z.union(['echo', 'llm', 'agent']).default('llm'),
    /** 回复消息的排版格式：markdown 富文本渲染（代码块/表格/列表）或纯文本。 */
    replyFormat: z.union(['markdown', 'text']).default('markdown'),
    systemPrompt: z.string().default('你是部署在飞书上的智能助手。请用简洁、友好的中文回答用户的问题；'
        + '涉及代码时直接给出可运行的代码块。'),
    provider: z.string(),
    model: z.string(),
    maxHistory: z.number().min(0).default(20),
    agentId: z.string(),
    agentPreset: z.string(),
    workspace: z.string(),
    commands: z.boolean().default(true),
    resetCommands: z.array(z.string()).default(['/new', '/reset']),
    attachHistory: z.number().min(0).default(5),
    pushChatId: z.string(),
    tools: z.boolean().default(true),
});
/** 把 `env:VAR` 形式的配置值解析为环境变量值。 */
export function resolveSecret(raw) {
    if (raw.startsWith('env:')) {
        const name = raw.slice(4);
        const value = process.env[name];
        if (value === undefined) {
            throw new Error(`feishu-bot: 环境变量 ${name} 未设置（配置项使用了 env: 引用）`);
        }
        return value;
    }
    return raw;
}
export function apply(ctx, config) {
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
        },
    });
    // 插件卸载时断开长连接。
    ctx.effect(() => {
        return () => {
            void service.disconnect().catch((error) => {
                ctx.logger.warn('feishu: 断开长连接失败', error);
            });
        };
    });
    // 建立长连接（SDK 自动重连；初始失败只记录日志，不阻断插件加载）。
    void service.connect()
        .then(() => {
        const identity = service.getBotIdentity();
        ctx.logger.info(`feishu: 长连接已就绪（机器人：${identity?.name ?? identity?.openId ?? 'unknown'}）`);
    })
        .catch((error) => {
        ctx.logger.error('feishu: 连接长连接失败，请检查 appId/appSecret 与网络（SDK 将自动重试）', error);
    });
    // 入站互动：飞书消息 → 机器人回复。
    attachInbound(ctx, service, config);
    // 出站互动：模型可调用 feishu_* 工具。
    if (config.tools !== false) {
        registerFeishuTools(ctx, service, config.pushChatId);
    }
}
//# sourceMappingURL=index.js.map