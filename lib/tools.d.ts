/**
 * 模型可调用的 feishu_* 工具：让 DSH agent 通过已绑定的机器人主动与
 * 飞书互动（发消息、回复、查会话、查消息、查连接状态）。
 *
 * 依赖 `ctx.tools`；未加载该服务时跳过注册并告警。
 *
 * @module dsh-feishu-bot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FeishuService } from './service.ts';
export declare function registerFeishuTools(ctx: Context, service: FeishuService): void;
//# sourceMappingURL=tools.d.ts.map