/**
 * 入站消息处理：把飞书用户发来的消息转成机器人的回复。
 *
 * 三种模式（config.mode）：
 * - `echo`  回显原文，用于验证绑定是否打通；
 * - `llm`   用 `ctx.llm` 直接生成回复（自包含、无需 agent 会话）；
 * - `agent` 把消息转交给 DSH agent 处理，再把该 agent 新产生的 assistant
 *           文本回发到飞书。
 *
 * agent 模式的会话策略（每个飞书会话独立维护）：
 * - 未指定 `agentId`：自动创建专属 DSH agent（首条消息创建、后续复用）；
 * - 指定 `agentId`：复用该会话；
 * - 可用飞书命令管理会话（config.commands，默认开启）：
 *   `/new` `/reset`      清空当前会话上下文（销毁专属 agent，下条消息新建）
 *   `/sessions`          列出当前活跃的 DSH agent 会话
 *   `/attach <会话id>`   接手 GUI 中某个既有会话（此后该飞书会话驱动它）
 *   `/detach`            解除接手，回到自动创建模式
 *
 * @module dsh-feishu-bot/inbound
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MarkdownStreamController, SendResult } from '@larksuiteoapi/node-sdk';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { FeishuService } from './service.ts';
import type { Config } from './index.ts';
import { type PendingQuestionState } from './questions.ts';
import type { ChatSessionStore } from './persistence.ts';
/** 一个进行中的流式转发会话（按 agentId 索引）。 */
interface ChatStream {
    /** 归属的飞书 chat_id。 */
    chatId: string;
    /** 归属的 agent id。 */
    agentId: string;
    /** 当前正在编辑的飞书消息 id（旧链路使用；原生链路结束时回填）。 */
    messageId?: string;
    /** 原生卡片流式 run() 的 promise（进行中）；undefined = 未启动。 */
    streamRun?: Promise<SendResult>;
    /** 原生流式控制器（producer 启动后可用；undefined = 未启动/已降级）。 */
    streamController?: MarkdownStreamController;
    /** 结束信号：relayEnd/熔断时 resolve，producer 返回后 SDK 收尾卡片。 */
    streamDone?: {
        promise: Promise<void>;
        resolve: () => void;
    };
    /** 原生流式已失败（启动或更新失败）→ 走旧降级链路。 */
    streamFailed?: boolean;
    /** 累积文本。 */
    text: string;
    /** 待刷新的定时器。 */
    timer?: ReturnType<typeof setTimeout>;
    /** 是否在下一个工具调用时收尾（任务执行中回应问题的路径）。 */
    stopOnToolCall: boolean;
    /** 是否以 markdown 卡片模式流式（旧链路：首条为卡片，后续 updateCard 更新）。 */
    cardMode: boolean;
    /** 复读熔断已触发：丢弃后续增量，不再转发。 */
    tripped?: boolean;
    /** 旧链路已补发的分段卡片数（首段之外，内容只增不减，发一次即可）。 */
    extraSegments: number;
    /** 分段阈值（字符）：旧链路按代码围栏/标题分多张卡片。 */
    segmentChars: number;
}
/**
 * 按代码围栏/标题把长文本切成 ≤ limit 的多段（与 SDK 内部同一算法）：
 * - 按行切，绝不把行切半；
 * - 代码块保持完整（超限时闭合 ```，下一段重新打开）；
 * - 接近上限时优先在标题行（# 开头）断开。
 */
export declare function splitWithCodeFences(text: string, limit: number): string[];
/** 尾部重复检测结果。 */
export interface TailRepetition {
    /** 重复单元长度（字符）。 */
    unitLength: number;
    /** 单元在尾部连续出现的次数。 */
    repeats: number;
    /** 重复段总长（unitLength × repeats）。 */
    totalLength: number;
}
/**
 * 检测 text 尾部是否由同一单元连续重复构成（复读循环特征）。
 * 只检查最后 REPETITION_WINDOW 个字符；命中返回重复信息，否则 null。
 * 单元下限 4 字符排除 `────`、`====` 这类分隔线；非重复文本在首个
 * 比较即失配，扫描成本约为单元长度上限次快速比较。
 */
export declare function detectTailRepetition(text: string): TailRepetition | null;
/** 每个飞书会话的 agent 模式状态。 */
interface ChatBinding {
    /** `/attach` 接手的目标会话（GUI 会话等；不 dispose，只驱动）。 */
    bound?: Agent;
    /** 插件自动创建的专属会话（可 dispose 以重置上下文）。 */
    auto?: AgentHandle;
    /** 最近一次 `/sessions` 的编号 → 会话 id 映射（支持 /attach 数字选择）。 */
    lastList?: Array<{
        index: number;
        id: string;
    }>;
}
/** agent 模式共享状态：会话绑定、流式转发、确认问答、持久化。 */
export interface InboundShared {
    stateByChat: Map<string, ChatBinding>;
    relays: Map<string, ChatStream>;
    /** agent id → 飞书 chat_id（问答桥接与 steering 用）。 */
    chatByAgent: Map<string, string>;
    /** 飞书侧确认问答（ask_user_question 覆盖 / feishu_ask_choice）。 */
    questions: PendingQuestionState;
    /** chat_id → session_id 持久化映射（重启后 resume）。 */
    store?: ChatSessionStore;
}
/** 从自动创建的 agent id（feishu-<chatId>-<rand8>）反推 chat_id。 */
export declare function chatIdFromAgentId(id: string): string | undefined;
/**
 * 订阅飞书长连接事件，按 config.mode 路由每条入站消息。
 * 每个会话内的消息串行处理，避免并发回复交错。
 */
export declare function attachInbound(ctx: Context, service: FeishuService, config: Config, shared: InboundShared): void;
export {};
//# sourceMappingURL=inbound.d.ts.map