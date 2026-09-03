/**
 * 飞书侧「等待用户确认」机制：把 agent 的 ask_user_question（以及模型的
 * feishu_ask_choice）转成飞书里可点击的交互卡片，用户点按钮或直接回复
 * 编号即可回答，避免问题只出现在 Web GUI 导致 agent 回合永久挂起。
 *
 * 背景（2026-08-31 事故）：agent 在飞书会话里调用全局 ask_user_question
 * 时，问题只被 Web GUI 的 provider 渲染，飞书用户看不到也答不了 → 工具
 * Promise 永远 pending → 该 agent 回合永不结束 → 插件按 chatId 串行的
 * 消息队列被永久堵死，机器人「对话一轮就断」。本模块把回答通道接到飞书，
 * 并带超时兜底，保证任何情况下回合都能结束。
 *
 * 用法：
 * - {@link createPendingQuestionState} 创建共享状态（并订阅 cardAction）；
 * - agent 级 ask_user_question 覆盖（inbound.ts）调用 {@link askViaChat}；
 * - 入站文本消息先经 {@link consumeTextAnswer} 判断是否为问题回答；
 * - feishu_ask_choice 工具（tools.ts）调用 {@link askChoice}。
 *
 * @module dsh-feishu-bot/questions
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { FeishuService } from './service.ts';
/** 单个待确认问题（与全局 ask_user_question 的 question 结构一致）。 */
export interface AskQuestion {
    id: string;
    question: string;
    header?: string;
    options?: string[];
    multiSelect?: boolean;
}
/** ask_user_question 工具的输出载荷（与全局工具一致，供模型消费）。 */
export interface AskAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
/** 一个进行中的确认请求。 */
export interface PendingQuestion {
    /** 唯一请求 id，同时编码进按钮 value 与文本回执。 */
    qid: string;
    chatId: string;
    /** 发起 agent（ask 覆盖路径）；feishu_ask_choice 可能来自任意 agent。 */
    agentId?: string;
    questions: AskQuestion[];
    /** question id → 已选标签（按钮点击累积，文本回复覆盖）。 */
    answers: Map<string, string[]>;
    /** 问题卡片 message id（发送成功后回填，结束时回写结果视图）。 */
    cardMessageId?: string;
    resolve: (value: {
        answers: AskAnswerItem[];
    }) => void;
    reject: (error: Error) => void;
    /** 超时定时器（未答则 reject ASK_TIMEOUT）。 */
    timer: ReturnType<typeof setTimeout>;
    /** 已完结（resolve/reject 只触发一次）。 */
    finished: boolean;
    /** 提示文本已发送（避免重复）。 */
    hinted: boolean;
    /** 调用方中止信号（cleanup 时移除监听）。 */
    signal?: AbortSignal;
    /** 中止监听器引用（cleanup 时移除）。 */
    onAbort?: () => void;
}
/** 问答题结束方式（决定结果卡片视图）。 */
export type QuestionOutcome = {
    kind: 'answered';
} | {
    kind: 'timeout';
} | {
    kind: 'cancelled';
} | {
    kind: 'aborted';
} | {
    kind: 'error';
    message: string;
};
/** 待确认状态：按 chatId 维护栈（同会话并发询问取最新未答），按 qid 索引。 */
export declare class PendingQuestionState {
    private readonly ctx;
    private readonly service;
    private readonly timeoutMs;
    /**
     * 发起问答前置钩子（inbound.ts 注入）：问题卡片上屏前收尾该会话当前
     * 的原生打字机流式卡片。等待回答可能长达数分钟，而 cardkit 流式卡片
     * 服务端 ~10 分钟自动关闭——等待期不收尾，回答后的续写就会撞上硬限、
     * 原 卡冻结 + 新卡闪现（2026-09-03「选择后断流」事故）。
     */
    onAskPresented?: (chatId: string, agentId: string | undefined) => void;
    /**
     * 问答回答钩子（inbound.ts 注入）：为回答后的续写立即上屏新占位
     * 打字机卡片；relay 已不存在但 agent 仍在跑时重建 relay（steer 路径
     * 的 ask），保证回答后的输出继续流式转发、不丢。
     */
    onAnswered?: (chatId: string, agentId: string | undefined) => void;
    private readonly byChat;
    private readonly byQid;
    constructor(ctx: Context, service: FeishuService, timeoutMs: number);
    /**
     * 发起一次飞书确认：发送按钮卡片 + 编号提示，等待按钮点击 / 文本回复 /
     * 超时 / 中止信号。
     * @param chatId 目标会话
     * @param agentId 发起 agent id（可选）
     * @param questions 问题列表
     * @param signal 工具调用的中止信号（agent 回合取消时同步取消）
     * @param timeoutMs 覆盖默认超时（可选）
     * @returns 与全局 ask_user_question 相同的 { answers } 载荷
     */
    askViaChat(chatId: string, agentId: string | undefined, questions: AskQuestion[], signal: AbortSignal | undefined, timeoutMs?: number): Promise<{
        answers: AskAnswerItem[];
    }>;
    /** 该会话是否存在未完结的待确认问题。 */
    hasPending(chatId: string): boolean;
    /**
     * 取消该会话当前所有待确认问题（agent 会收到 ASK_CANCELLED 错误结果，
     * 自行决定继续或收尾）。返回是否确有挂起问题被取消。
     */
    cancelFor(chatId: string): boolean;
    /** 发送确认交互卡片 + 编号提示文本（cardAction 主通道 + 文本兜底）。 */
    private present;
    /** 触发 onAnswered 钩子（异常不外溢，不影响回答回流）。 */
    private emitAnswered;
    /**
     * 把问题卡片回写为结果视图（2026-09-03）：回答/超时/取消后卡片不再
     * 留着一排可点的按钮，而是定格为「✅ 已选择：xx」等结果，用户一眼
     * 看到当前进度。回写失败不影响回答本身（best effort）。
     */
    private finalizeCard;
    /**
     * 尝试把一条入站文本当作问题回答消费掉。命中返回 true（消息已处理，
     * 不应再走命令/agent 路由）；未命中返回 false。
     */
    consumeTextAnswer(chatId: string, text: string): boolean;
    /** 处理卡片按钮点击。 */
    private onCardAction;
    /** 超时兜底：回合必须能结束（agent 会收到错误结果并继续/收尾）。 */
    private finishTimeout;
    private push;
    private cleanup;
}
/**
 * 把文本回复解析为「问题 id → 选项标签」：
 * - 纯编号（如 `1`、`2,3`、`1 3`）：第 k 个数字回答第 k 个问题（1 基）；
 * - 与某个未回答问题的选项标签完全一致：回答该问题。
 * 其余文本（含 / 开头命令）返回 null，按普通消息处理。
 */
export declare function parseAnswerText(pending: PendingQuestion, text: string): Map<string, string[]> | null;
/** 确认交互卡片（schema 2.0，按钮 value 编码 qid/question/option）。 */
export declare function buildQuestionCard(pending: PendingQuestion): object;
/**
 * 问答结束后的结果卡片（2026-09-03）：纯文本视图，不再有按钮——
 * 回答后卡片定格为「✅ 已选择：xx」，超时/取消也如实标注，避免
 * 用户点击后卡片毫无变化、还能反复点（旧交互的困惑点）。
 */
export declare function buildResultCard(pending: PendingQuestion, outcome: QuestionOutcome): object;
/** 确认提示文本（卡片之外补一条，明确告知可回复编号；卡片发送失败时文本兜底可答）。 */
export declare function buildQuestionHint(pending: PendingQuestion): string;
/**
 * 为自动创建的飞书 agent 注册「飞书版 ask_user_question」。
 * 挂到 agent 的 ctx（agent 级 shadowing，覆盖全局 GUI 版）：
 * 问题以交互卡片发到飞书，回答通过按钮/文本回流，超时兜底。
 */
export declare function defineFeishuAskTool(state: PendingQuestionState, chatIdFor: (agentId: string | undefined) => string | undefined): ReturnType<typeof defineTool>;
//# sourceMappingURL=questions.d.ts.map