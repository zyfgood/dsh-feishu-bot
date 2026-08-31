/**
 * 模型可调用的工具：feishu_*（飞书互动）。
 *
 * 依赖 `ctx.tools`；未加载该服务时跳过注册并告警。
 *
 * @module dsh-feishu-bot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FeishuService } from './service.ts';
import type { PendingQuestionState } from './questions.ts';
export declare function registerFeishuTools(ctx: Context, service: FeishuService, pushChatId?: string, questions?: PendingQuestionState): void;
//# sourceMappingURL=tools.d.ts.map