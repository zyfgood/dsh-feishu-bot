/**
 * 模型可调用的工具：feishu_*（飞书互动）与 email_send（邮件通知）。
 *
 * 依赖 `ctx.tools`；未加载该服务时跳过注册并告警。
 *
 * @module dsh-feishu-bot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FeishuService } from './service.ts';
import { type EmailConfig } from './mail.ts';
/** 注册邮件发送工具（仅当 email 配置存在时）。 */
export declare function registerEmailTool(ctx: Context, email: EmailConfig): void;
export declare function registerFeishuTools(ctx: Context, service: FeishuService, pushChatId?: string): void;
//# sourceMappingURL=tools.d.ts.map