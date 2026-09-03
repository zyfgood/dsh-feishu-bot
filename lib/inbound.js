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
import { randomUUID } from 'node:crypto';
import { createAssistantMessage, createUserMessage, } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineFeishuAskTool, } from "./questions.js";
/** 流式转发到飞书的节流间隔（ms）：飞书消息编辑有限频，聚合后批量更新。 */
const STREAM_FLUSH_MS = 400;
/**
 * 原生卡片单卡安全上限（字符）：飞书卡片 JSON 有 30KB 硬限制（错误码
 * 200860），CJK 每字 3 字节，8000 字符 ≈ 24KB 留有安全余量。超过此值
 * 的内容切旧链路分段发送（旧链路对超限卡片自动降级纯文本，内容不丢）。
 */
const NATIVE_CARD_SAFE_CHARS = 8000;
/**
 * 原生卡片流式最长开启时间（ms）：飞书卡片流式模式超时自动关闭
 * （错误码 200850，约 10 分钟）。agent 长任务中文本输出间隔可能很长，
 * 提前钉住卡片切旧链路，避免流式中途失效后静默停止。
 */
const STREAM_MAX_OPEN_MS = 8 * 60_000;
/**
 * 按代码围栏/标题把长文本切成 ≤ limit 的多段（与 SDK 内部同一算法）：
 * - 按行切，绝不把行切半；
 * - 代码块保持完整（超限时闭合 ```，下一段重新打开）；
 * - 接近上限时优先在标题行（# 开头）断开。
 */
export function splitWithCodeFences(text, limit) {
    if (text.length <= limit)
        return [text];
    const lines = text.split('\n');
    const out = [];
    let buf = [];
    let bufLen = 0;
    let fenceLang = null;
    const flush = () => {
        if (buf.length === 0)
            return;
        let chunk = buf.join('\n');
        if (fenceLang !== null)
            chunk += '\n```';
        out.push(chunk);
        buf = [];
        bufLen = 0;
        if (fenceLang !== null) {
            // 下一段重新打开代码块
            buf.push(`\`\`\`${fenceLang}`);
            bufLen = buf[0].length;
        }
    };
    for (const line of lines) {
        const m = /^```(\w*)$/.exec(line);
        const lineLen = line.length + (buf.length > 0 ? 1 : 0);
        const isHeading = /^#{1,6}\s/.test(line);
        const nearFull = bufLen > limit * 0.75;
        if (bufLen + lineLen > limit || (isHeading && nearFull && buf.length > 0)) {
            flush();
        }
        buf.push(line);
        bufLen += lineLen;
        if (m)
            fenceLang = fenceLang === null ? (m[1] || '') : null;
    }
    flush();
    return out;
}
/** 检测窗口与阈值：窗口须容纳 MAX_UNIT × MIN_REPEATS。 */
const REPETITION_WINDOW = 12_000;
const REPETITION_MIN_UNIT = 4;
const REPETITION_MAX_UNIT = 2_000;
const REPETITION_MIN_REPEATS = 6;
const REPETITION_MIN_TOTAL = 400;
/** 熔断截断时保留的重复次数（保留「确实在重复」的最小证据）。 */
const REPETITION_KEEP_REPEATS = 2;
/**
 * 检测 text 尾部是否由同一单元连续重复构成（复读循环特征）。
 * 只检查最后 REPETITION_WINDOW 个字符；命中返回重复信息，否则 null。
 * 单元下限 4 字符排除 `────`、`====` 这类分隔线；非重复文本在首个
 * 比较即失配，扫描成本约为单元长度上限次快速比较。
 */
export function detectTailRepetition(text) {
    const window = text.length > REPETITION_WINDOW ? text.slice(text.length - REPETITION_WINDOW) : text;
    if (window.length < REPETITION_MIN_TOTAL)
        return null;
    const maxUnit = Math.min(REPETITION_MAX_UNIT, Math.floor(window.length / REPETITION_MIN_REPEATS));
    for (let unitLength = REPETITION_MIN_UNIT; unitLength <= maxUnit; unitLength += 1) {
        const unit = window.slice(window.length - unitLength);
        let repeats = 0;
        let end = window.length;
        while (end >= unitLength && window.slice(end - unitLength, end) === unit) {
            repeats += 1;
            end -= unitLength;
        }
        if (repeats >= REPETITION_MIN_REPEATS && repeats * unitLength >= REPETITION_MIN_TOTAL) {
            // 最短命中单元已足以判定；更长单元只是同一现象的周期倍数。
            return { unitLength, repeats, totalLength: repeats * unitLength };
        }
    }
    return null;
}
/** 从自动创建的 agent id（feishu-<chatId>-<rand8>）反推 chat_id。 */
export function chatIdFromAgentId(id) {
    if (!id.startsWith('feishu-'))
        return undefined;
    const rest = id.slice('feishu-'.length);
    const match = /^(.*)-[0-9a-f]{8}$/.exec(rest);
    return match ? match[1] : rest;
}
/** 每会话保留的最大消息条数（含 user + assistant，即 maxHistory 轮对话）。 */
function trimHistory(history, max) {
    if (max <= 0)
        return [];
    return history.length > max * 2 ? history.slice(history.length - max * 2) : [...history];
}
/** 从 assistant 消息的 content 中提取可见文本。 */
function assistantText(blocks) {
    return blocks
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
}
/** 收集会话日志中某 seq 之后新增的 assistant 可见文本。 */
function collectAssistantText(events, afterSeq) {
    const parts = [];
    for (const event of events) {
        if (event.seq <= afterSeq || event.type !== 'assistant/message')
            continue;
        const data = event.data;
        const text = assistantText(data.message?.content ?? []);
        if (text)
            parts.push(text);
    }
    return parts.join('\n').trim();
}
/** 当前回复排版格式（attachInbound 时按配置设定，默认 markdown 富文本）。 */
let replyFormat = 'markdown';
/** 引用回复用户消息；markdown 模式优先富文本，失败逐级降级为纯文本。 */
async function safeReply(ctx, service, msg, text) {
    if (!text)
        return;
    const inputs = replyFormat === 'markdown' ? [{ markdown: text }, { text }] : [{ text }];
    for (const input of inputs) {
        try {
            await service.send(msg.chatId, input, { replyTo: msg.messageId });
            return;
        }
        catch (error) {
            ctx.logger.warn('feishu: 引用回复失败，尝试降级/直接发送', error);
            try {
                await service.send(msg.chatId, input);
                return;
            }
            catch (inner) {
                ctx.logger.warn('feishu: 直接发送失败，继续降级', inner);
            }
        }
    }
    ctx.logger.error('feishu: 所有回复发送方式均失败');
}
/** 会话的可读标题：优先取 session-title 服务的折叠标题，其次用描述性兜底。 */
function sessionDisplayTitle(ctx, agent) {
    const sessionTitle = ctx.get('sessionTitle');
    const title = sessionTitle?.get(agent.session)?.title?.trim();
    if (title)
        return title;
    const cwdBase = agent.session.header.cwd?.split(/[\\/]/).filter(Boolean).pop();
    if (agent.id.startsWith('feishu-'))
        return `飞书会话 · ${cwdBase ?? '?'}`;
    return `（未命名）· ${cwdBase ?? '?'}`;
}
/**
 * 会话 id 展示缩写：长 id 保留首尾（如 `feishu-oc_ab…cd1234ef`），便于在
 * 飞书消息里与 /sessions 列表的完整 id 对照；短 id 原样返回。
 */
function shortSessionId(id) {
    return id.length <= 24 ? id : `${id.slice(0, 12)}…${id.slice(-8)}`;
}
/** 把某个会话登记进工作区（cwd 与 workspace path 匹配时才会成功）。 */
async function attachToWorkspace(ctx, sessionId, workspacePath) {
    if (!workspacePath)
        return;
    const registry = ctx.get('workspaceRegistry');
    if (!registry)
        return;
    try {
        let workspace = await registry.resolveByPath(workspacePath);
        if (!workspace) {
            workspace = await registry.create(workspacePath, workspacePath.split(/[\\/]/).filter(Boolean).pop());
        }
        await workspace.attachSession(sessionId);
        ctx.logger.info(`feishu: 会话 ${sessionId} 已归入工作区 ${workspacePath}`);
    }
    catch (error) {
        ctx.logger.warn(`feishu: 会话 ${sessionId} 归入工作区失败（不影响使用）`, error);
    }
}
/**
 * 会话被机器人激活（创建/resume/接手/复用）时，若其处于「已归档」状态则
 * 自动取消归档。背景（2026-09-02）：用户在 GUI 里归档了大量会话（含
 * 飞书 bot 的旧会话），此后机器人 resume 同一会话继续对话，但归档会话在
 * 工作区树中被隐藏——「机器人明明在干活，会话却不在列表里」。激活即恢复，
 * 与 attachToWorkspace 一样是幂等动作；无 registry API 时静默跳过。
 */
async function unarchiveIfNeeded(ctx, sessionId) {
    const registry = ctx.get('workspaceRegistry');
    if (!registry || !registry.requireState || !registry.setState)
        return;
    try {
        const archived = registry.archivedSessionIds ?? registry.requireState().archivedSessionIds ?? [];
        if (!archived.includes(sessionId))
            return;
        const next = archived.filter(id => id !== sessionId);
        if (next.length === archived.length)
            return;
        await registry.setState({ ...registry.requireState(), archivedSessionIds: next });
        ctx.logger.info(`feishu: 会话 ${sessionId} 已自动取消归档（恢复在工作区列表显示）`);
    }
    catch (error) {
        ctx.logger.warn(`feishu: 自动取消归档会话 ${sessionId} 失败（可在 GUI 归档管理中手动恢复）`, error);
    }
}
/** 提取一条 user/assistant 消息的可见文本（截断到 maxChars）。 */
function messageText(content, maxChars) {
    const text = assistantText(content ?? []);
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
/**
 * 把会话最近的历史（用户/助手消息）发送到飞书，便于接手后接着对话。
 * `count <= 0` 时不发送。按时间正序展示（最近的在后）。
 */
async function sendRecentHistory(ctx, service, msg, agent, count) {
    if (count <= 0)
        return;
    const rows = [];
    for (const event of agent.session.events) {
        if (event.type === 'user/message') {
            const data = event.data;
            const text = messageText(data.content, 200);
            if (text)
                rows.push(`👤 我：${text}`);
        }
        else if (event.type === 'assistant/message') {
            const data = event.data;
            const text = messageText(data.message?.content, 200);
            if (text)
                rows.push(`🤖 助手：${text}`);
        }
    }
    const recent = rows.slice(-count);
    if (recent.length === 0)
        return;
    const body = recent.join('\n');
    // 总长保护：超出时丢掉最旧的部分，保留最近的。
    const MAX = 3000;
    const head = '📜 最近对话（从旧到新）：\n';
    const tail = '\n\n继续对话即可，/detach 解除接手。';
    const keep = body.length > MAX - head.length - tail.length ? body.slice(body.length - (MAX - head.length - tail.length)) : body;
    await safeReply(ctx, service, msg, `${head}${keep}${tail}`);
}
// ── 流式转发：agent 输出 → 飞书消息（首选原生卡片流式，降级旧链路）──
/** 立即把累积文本刷到飞书；final=true 时清理转发会话。
 *  首选原生卡片流式（cardkit 打字机效果，只传增量）；原生卡片只承载
 *  min(segmentChars, 8000) 以内的安全头部——超过上限或流式开启过久时
 *  钉住当前卡片，尾部切「首条卡片 + 后续编辑更新」的旧链路续传（内容
 *  完整不丢）；启动/更新失败或 text 排版模式时同样降级旧链路。 */
/**
 * 启动原生卡片流式（占位卡片 + 打字光标）。幂等：已启动 / 已降级 / 已钉头 /
 * text 排版模式时返回 false，不重复启动。
 *
 * producer 先播种启动前已累积的文本（单卡安全上限内正常播种；超上限只钉
 * 头部，绝不把超限内容喂给 SDK，避免触发 rollover/静默冻结，尾部由主流程
 * 切旧链路续传），再等待 relayEnd/熔断的收尾信号。启动失败（缺 cardkit
 * 权限等）由 `.catch` 标记 `streamFailed`，首批文本自动降级旧链路；占位
 * 场景（尚无文本）下失败静默无害。
 */
function startNativeStream(ctx, service, relays, relay) {
    if (relay.streamRun !== undefined || relay.streamFailed || relay.nativeDone || replyFormat !== 'markdown') {
        return false;
    }
    const nativeCap = Math.min(relay.segmentChars, NATIVE_CARD_SAFE_CHARS);
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    relay.streamDone = { promise: done, resolve: resolveDone };
    relay.streamStartedAt = Date.now();
    relay.streamRun = service.streamMarkdown(relay.chatId, async (controller) => {
        relay.streamController = controller;
        if (relay.text.trim() !== '')
            await controller.setContent(relay.text.trim().slice(0, nativeCap));
        await done;
    });
    // 正常结束：回填 messageId（统计/日志用）。
    relay.streamRun.then((result) => { relay.messageId = result.messageId; }).catch(() => { });
    // 启动失败（缺 cardkit 权限等）→ 降级旧链路重发普通卡片；
    // 已钉头切链路的 relay 由主流程接管，这里短路避免双重发送。
    relay.streamRun.catch((error) => {
        if (relay.nativeDone)
            return;
        relay.streamFailed = true;
        relay.streamController = undefined;
        ctx.logger.warn('feishu: 原生卡片流式启动失败，降级为普通卡片流式', error);
        void relayFlush(ctx, service, relays, relay, false);
    });
    return true;
}
/**
 * 立即启动原生流式「占位卡片」（v0.6.7）：agent 回合开始、首批文本尚未
 * 产生时，先把占位文案（`outbound.streamInitialText`，默认「收到，正在
 * 处理…」）的打字机卡片发到飞书——工具执行期不再完全静默，避免用户把
 * 「模型闷头跑工具、文本集中在结尾产出」误认为「没有流式、最终完成才
 * 回复」。首批文本到达后 relayFlush 直接 setContent 续写同一张卡片，
 * 无缝衔接、不多发消息；启动失败静默降级（首批文本走旧链路）。
 */
function relayShowPlaceholder(ctx, service, relays, relay) {
    if (startNativeStream(ctx, service, relays, relay)) {
        ctx.logger.debug(`feishu: 占位卡片已上屏（agent=${relay.agentId}）`);
    }
}
/**
 * 孤儿 relay 收尾：会话被 steer 接管（relay 对象被替换）时，旧 relay 的
 * 原生流式若仍未收尾，占位卡会带着打字光标挂到飞书约 10 分钟自动关闭。
 * 这里主动收尾：尚无文本的占位卡给一句中性提示，已有文本的保持原样定格。
 */
function closeOrphanStream(relay) {
    if (relay === undefined || relay.streamRun === undefined || relay.streamDone === undefined)
        return;
    const done = relay.streamDone;
    void (async () => {
        if (relay.streamController !== undefined && !relay.streamFailed && relay.text.trim() === '') {
            try {
                await relay.streamController.setContent('（已被新消息接管，此处收尾）');
            }
            catch { /* best effort */ }
        }
        done.resolve();
    })();
}
async function relayFlush(ctx, service, relays, relay, final) {
    if (relay.timer !== undefined) {
        clearTimeout(relay.timer);
        relay.timer = undefined;
    }
    // 复读熔断：尾部检出大段完全重复 → 截断保留少量重复 + 告警，并停流。
    if (!relay.tripped) {
        const repetition = detectTailRepetition(relay.text);
        if (repetition) {
            relay.tripped = true;
            const cut = relay.text.length - (repetition.totalLength - repetition.unitLength * REPETITION_KEEP_REPEATS);
            relay.text = `${relay.text.slice(0, Math.max(0, cut)).trimEnd()}\n\n⚠️ 检测到输出异常重复（${repetition.unitLength} 字符 × ${repetition.repeats} 次），已自动截断。`;
            ctx.logger.warn(`feishu: 复读熔断触发（agent=${relay.agentId}，单元 ${repetition.unitLength} 字符连续 ${repetition.repeats} 次，共 ${relay.text.length} 字符处截断）`);
        }
    }
    const text = relay.text.trim();
    if (!text) {
        if (final) {
            // 空收尾：占位卡片先给一句中性提示再收尾（否则 SDK 会以默认
            // '(no content)' 定格，对中文用户不友好）。
            if (relay.streamController !== undefined && relay.streamRun !== undefined && !relay.streamFailed) {
                try {
                    await relay.streamController.setContent('（本轮没有文本输出）');
                }
                catch { /* best effort */ }
            }
            relay.streamDone?.resolve(); // 兜底：让已启动的流式正常收尾
            relays.delete(relay.agentId);
        }
        return;
    }
    // ── 原生卡片流式：已启动 → 只传增量；钉头/收尾/熔断时结束 ─────
    if (relay.streamRun !== undefined && !relay.streamFailed) {
        let cutover = false;
        if (relay.streamController !== undefined && text !== '') {
            // 单卡安全上限：CJK 8000 字符 ≈ 24KB，低于飞书 30KB 卡片硬限制
            // （200860）。超过上限或流式开启过久（飞书约 10 分钟自动关闭
            // 200850）时钉住当前卡片，尾部交旧链路续传——原生路径绝不触发
            // SDK 的 rollover：全量 setContent 触发 rollover 会刷重复卡片、
            // 遇到超长单行还会在 SDK 内部静默冻结（streamingFailed 不抛给插件）。
            const nativeCap = Math.min(relay.segmentChars, NATIVE_CARD_SAFE_CHARS);
            const overdue = relay.streamStartedAt !== undefined && Date.now() - relay.streamStartedAt > STREAM_MAX_OPEN_MS;
            cutover = text.length > nativeCap || overdue;
            if (cutover) {
                const chunks = splitWithCodeFences(text, nativeCap);
                // 不可切分（超长单行）时按字符硬截头部，尾部照常续传，内容不丢。
                const head = chunks.length > 1 ? chunks[0] : text.slice(0, nativeCap);
                try {
                    await relay.streamController.setContent(head);
                }
                catch (error) {
                    ctx.logger.warn('feishu: 原生流式钉头更新失败，直接切旧链路', error);
                }
                // 结束原生流式（finishStreamingCard 移除打字光标）。
                relay.streamDone?.resolve();
                try {
                    const result = await relay.streamRun;
                    relay.messageId = result.messageId;
                }
                catch {
                    // 流式失败：标记降级，由下方旧链路续传（启动处 .catch 已按
                    // nativeDone 短路，不会重复处理）。
                    relay.streamFailed = true;
                }
                relay.streamRun = undefined;
                relay.streamController = undefined;
                relay.nativeDone = true;
                relay.messageId = undefined;
                relay.cardMode = false;
                relay.extraSegments = 0;
                relay.text = chunks.length > 1 ? chunks.slice(1).join('\n') : text.slice(nativeCap);
                ctx.logger.info(`feishu: 原生流式钉头收尾（head=${head.length}，${overdue ? '超时' : `超上限 ${text.length} 字符`}），尾部 ${relay.text.length} 字符切旧链路`);
                // 落到旧链路（不 return）：尾段卡片即时上屏，后续按旧链路刷新。
            }
            else {
                try {
                    // setContent 传全量累积文本，SDK 内部 diff 出增量再上屏（打字机效果）。
                    await relay.streamController.setContent(text);
                }
                catch (error) {
                    ctx.logger.warn('feishu: 原生流式更新失败，降级为普通卡片流式', error);
                    relay.streamFailed = true;
                    relay.streamController = undefined;
                    // 让 producer 收尾（finishStreamingCard），避免占位卡停留在打字状态。
                    relay.streamDone?.resolve();
                    if (final) {
                        // 收尾原生流式，并用旧链路补发最终内容（新卡片/文本）。
                        try {
                            await relay.streamRun;
                        }
                        catch { /* 已降级 */ }
                        relays.delete(relay.agentId);
                        relay.messageId = undefined;
                        relay.cardMode = false;
                        return relayFlush(ctx, service, relays, relay, true);
                    }
                }
            }
        }
        if (!cutover) {
            if (final || relay.tripped) {
                relay.streamDone?.resolve();
                const run = relay.streamRun;
                if (run !== undefined) {
                    try {
                        const result = await run;
                        relay.messageId = result.messageId;
                    }
                    catch {
                        // 启动失败已由下方 .catch 降级路径接管，这里只收尾。
                    }
                }
                relays.delete(relay.agentId);
            }
            return;
        }
        // cutover：继续执行旧链路（relay.text 已替换为尾部）。
    }
    // ── 原生卡片流式：未启动（首刷）→ 启动占位卡片 ──────────────
    if (startNativeStream(ctx, service, relays, relay)) {
        const nativeCap = Math.min(relay.segmentChars, NATIVE_CARD_SAFE_CHARS);
        if (final || relay.tripped) {
            relay.streamDone?.resolve();
            const run = relay.streamRun;
            let ok = run !== undefined;
            if (run !== undefined) {
                try {
                    const result = await run;
                    relay.messageId = result.messageId;
                }
                catch {
                    // 流式失败：由上方 .catch 降级路径接管（旧链路全文重发），
                    // 这里不再补发，避免双重发送。
                    ok = false;
                }
            }
            if (ok && relay.text.trim().length > nativeCap) {
                // 首刷即超上限：原生卡片只承载头部，尾部切旧链路分段补发。
                const full = relay.text.trim();
                const chunks = splitWithCodeFences(full, nativeCap);
                relay.nativeDone = true;
                relay.streamRun = undefined;
                relay.streamController = undefined;
                relay.messageId = undefined;
                relay.cardMode = false;
                relay.extraSegments = 0;
                relay.text = chunks.length > 1 ? chunks.slice(1).join('\n') : full.slice(nativeCap);
                ctx.logger.info(`feishu: 原生流式首刷即钉头收尾（head ≤ ${nativeCap}），尾部 ${relay.text.length} 字符切旧链路`);
                // 落到旧链路（不 return）：final 时一次补发全部分段。
            }
            else {
                relays.delete(relay.agentId);
                return;
            }
        }
        else {
            return;
        }
    }
    // ── 旧链路（原生流式降级 / 钉头切链路续传 / text 排版模式）────
    // 注意：原生钉头切链路后 relay.text 已替换为尾部，这里必须重新读取
    // （函数顶部的 text 快照此时已过期）。
    const sendText = relay.text.trim();
    try {
        // 分段：首段持续编辑更新，超出的段作为独立卡片消息补发（内容只增不减）。
        const segments = replyFormat === 'markdown' ? splitWithCodeFences(sendText, relay.segmentChars) : undefined;
        if (relay.messageId === undefined) {
            if (segments) {
                const result = await service.sendMarkdownCard(relay.chatId, segments[0]);
                relay.messageId = result.messageId;
                relay.cardMode = true;
            }
            else {
                const result = await service.send(relay.chatId, { text: sendText });
                relay.messageId = result.messageId;
                relay.cardMode = false;
            }
        }
        else if (relay.cardMode && segments) {
            await service.updateMarkdownCard(relay.messageId, segments[0]);
        }
        else {
            await service.channel.editMessage(relay.messageId, sendText);
        }
        if (relay.cardMode && segments) {
            // 超出首段的剩余内容：仅在收尾/熔断时补发（此时分段已定型，索引稳定、
            // 内容完整——流式中途分段边界会随文本增长漂移，中途补发可能丢内容）。
            if (final || relay.tripped) {
                for (let i = 1; i < segments.length; i += 1) {
                    if (i > relay.extraSegments) {
                        const result = await service.sendMarkdownCard(relay.chatId, segments[i]);
                        relay.extraSegments = i;
                        void result;
                    }
                }
            }
        }
    }
    catch (error) {
        ctx.logger.warn('feishu: 流式刷新消息失败（卡片降级为纯文本续流）', error);
        if (relay.cardMode) {
            // 卡片发送/更新失败：降级为纯文本流式（重发一条文本，后续走 editMessage）。
            relay.cardMode = false;
            relay.messageId = undefined;
            try {
                const result = await service.send(relay.chatId, { text: sendText });
                relay.messageId = result.messageId;
            }
            catch (inner) {
                ctx.logger.warn('feishu: 降级纯文本发送仍失败，保留待重试', inner);
                relay.messageId = undefined;
            }
        }
        else if (relay.messageId !== undefined) {
            // 编辑失败时保留已发内容，后续重试编辑；这里只记录。
            relay.messageId = undefined;
        }
    }
    if (final || relay.tripped)
        relays.delete(relay.agentId);
}
/** 追加一段文本并安排节流刷新。 */
function relayAppend(ctx, service, relays, relay, delta) {
    if (relay.tripped)
        return; // 熔断后丢弃增量，等待 agent 自然结束
    relay.text += delta;
    if (relay.timer === undefined) {
        relay.timer = setTimeout(() => {
            void relayFlush(ctx, service, relays, relay, false);
        }, STREAM_FLUSH_MS);
    }
}
/** 收尾（最终完整文本刷出并清理）。 */
function relayEnd(ctx, service, relays, relay) {
    void relayFlush(ctx, service, relays, relay, true);
}
/** llm 模式：调用 ctx.llm 生成回复，并维护每个会话的短期记忆。 */
async function llmReply(ctx, service, config, history, msg, text) {
    const llm = ctx.get('llm');
    if (!llm) {
        await safeReply(ctx, service, msg, '（当前环境未加载 LLM 服务，无法自动回复）');
        return;
    }
    if (!config.provider || !config.model) {
        await safeReply(ctx, service, msg, '（插件未配置 provider/model，无法自动回复，请在 cordis.yml 中补充）');
        return;
    }
    const userMessage = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    const prior = history.get(msg.chatId) ?? [];
    const messages = [...prior, userMessage];
    let reply = '';
    let failed = false;
    try {
        const stream = llm.stream({
            provider: config.provider,
            model: config.model,
            messages,
            system: config.systemPrompt,
        });
        for await (const chunk of stream) {
            if (chunk.type === 'text-delta') {
                reply += chunk.text;
            }
            else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                failed = true;
                reply = `（模型调用失败：${chunk.reason.failure.message}）`;
            }
        }
    }
    catch (error) {
        failed = true;
        reply = `（回复生成失败：${error instanceof Error ? error.message : String(error)}）`;
    }
    const trimmed = reply.trim();
    if (!failed && trimmed) {
        const assistantMessage = createAssistantMessage({
            content: [{ type: 'text', text: trimmed }],
            source: { provider: config.provider, model: config.model },
        });
        history.set(msg.chatId, trimHistory([...messages, assistantMessage], config.maxHistory ?? 20));
    }
    await safeReply(ctx, service, msg, trimmed || '（模型未返回任何内容）');
}
/** 检查 agent 是否仍是被注册表持有的活跃实例（避免给已销毁的 agent 发消息）。 */
function isLiveAgent(agents, agent) {
    return agents.get(agent.id) === agent;
}
/** 组装 agent 的 setup：挂载 preset + 注册飞书版 ask_user_question。 */
function buildAgentSetup(ctx, config, shared) {
    const chatIdFor = (agentId) => (agentId === undefined ? undefined : shared.chatByAgent.get(agentId)) ?? (agentId ? chatIdFromAgentId(agentId) : undefined);
    return async (agentCtx) => {
        // agent preset：与 GUI 新建会话一致，挂载 preset 内注册的工具
        // （bash/文件/技能等）。不挂载的话 agent 只有全局工具。
        const agentPresets = ctx.get('agentPresets');
        if (agentPresets) {
            const requested = config.agentPreset ?? agentPresets.defaultId;
            try {
                const resolved = await agentPresets.resolve(requested);
                await agentPresets.mount(agentCtx, resolved.id);
            }
            catch (error) {
                // 挂载失败不阻断创建：降级为全局工具，但记清楚日志便于排查。
                ctx.logger.error(`feishu: preset "${requested}" 挂载失败，该 agent 将使用全局工具运行`, error);
            }
        }
        // 飞书版 ask_user_question：agent 级 shadowing 覆盖全局 GUI 版，
        // 问题以交互卡片发到飞书，避免「问题只在 Web 界面、飞书侧永久挂起」。
        try {
            const tools = agentCtx.get?.('tools');
            if (tools && typeof tools.register === 'function') {
                ;
                tools.register(defineFeishuAskTool(shared.questions, chatIdFor));
            }
        }
        catch (error) {
            ctx.logger.warn('feishu: 注册飞书版 ask_user_question 失败，将使用全局 GUI 版（飞书侧确认可能不可用）', error);
        }
    };
}
/** 解析目标 agent：attach 绑定 > 配置 agentId > 自动创建/恢复/复用。 */
async function resolveAgent(ctx, config, shared, chatId) {
    const agents = ctx.get('agents');
    if (!agents) {
        return { ok: false, message: '（当前环境未加载 ctx.agents，无法使用 agent 模式）' };
    }
    const state = shared.stateByChat.get(chatId);
    // 1) /attach 接手的目标会话优先
    if (state?.bound) {
        if (isLiveAgent(agents, state.bound)) {
            shared.chatByAgent.set(state.bound.id, chatId);
            return { ok: true, agent: state.bound };
        }
        state.bound = undefined; // 目标已被销毁，解除绑定
    }
    // 2) 配置的 agentId
    if (config.agentId) {
        const agent = agents.get(SessionId(config.agentId));
        if (!agent) {
            return { ok: false, message: `（未找到 agent 会话 ${config.agentId}，请先配置或使用 /attach）` };
        }
        shared.chatByAgent.set(agent.id, chatId);
        return { ok: true, agent };
    }
    // 3) 自动创建/复用专属会话
    if (state?.auto && isLiveAgent(agents, state.auto.agent)) {
        shared.chatByAgent.set(state.auto.agent.id, chatId);
        return { ok: true, agent: state.auto.agent };
    }
    if (state?.auto)
        state.auto = undefined;
    // agent 必须带 provider/model：agent-loop 不自动兜底，缺失会导致
    // 提示词组装时 {{model}} 无值、agent 无法工作。配置未指定时读取
    // ctx.agentDefaultModel 的默认选择（base bundle 提供 deepseek-official）。
    let provider = config.provider;
    let model = config.model;
    if (!provider || !model) {
        const defaultModel = ctx.get('agentDefaultModel');
        if (defaultModel) {
            const selection = defaultModel.currentSelection();
            provider ??= selection.provider;
            model ??= selection.model;
        }
    }
    const agentOptions = provider && model ? { provider, model } : undefined;
    const setup = buildAgentSetup(ctx, config, shared);
    // 3.5) 持久化映射：重启/插件重载后恢复同一 DSH 会话，延续上下文
    if (config.persistSessions !== false && shared.store && typeof agents.resume === 'function') {
        const sessionId = shared.store.get(chatId);
        if (sessionId) {
            // 会话仍在线（例如被 GUI 或其他实例恢复）→ 直接接手，不新建。
            const live = agents.get(SessionId(sessionId));
            if (live) {
                shared.stateByChat.set(chatId, { bound: live });
                shared.chatByAgent.set(live.id, chatId);
                ctx.logger.info(`feishu: 复用已在线会话 ${sessionId}（飞书会话 ${chatId}）`);
                return { ok: true, agent: live };
            }
            try {
                const handle = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    ...(agentOptions ? { agentOptions } : {}),
                    setup,
                });
                shared.stateByChat.set(chatId, { auto: handle });
                shared.chatByAgent.set(handle.agent.id, chatId);
                ctx.logger.info(`feishu: 恢复会话 ${sessionId} 成功（飞书会话 ${chatId}）`);
                void attachToWorkspace(ctx, handle.agent.id, config.workspace ?? process.cwd());
                return { ok: true, agent: handle.agent };
            }
            catch (error) {
                ctx.logger.warn(`feishu: 恢复会话 ${sessionId} 失败，将新建会话`, error);
                shared.store.delete(chatId);
            }
        }
    }
    try {
        // meta 里记录解析后的 preset id（与 GUI 新建会话一致；解析失败则不带）。
        let agentPreset;
        const agentPresets = ctx.get('agentPresets');
        if (agentPresets) {
            try {
                const resolved = await agentPresets.resolve(config.agentPreset ?? agentPresets.defaultId);
                agentPreset = resolved.id;
            }
            catch (error) {
                ctx.logger.warn(`feishu: 解析 agent preset 失败，agent 将使用全局工具运行`, error);
            }
        }
        const handle = await agents.create({
            sessionId: SessionId(`feishu-${chatId}-${randomUUID().slice(0, 8)}`),
            meta: {
                cwd: config.workspace ?? process.cwd(),
                ...(agentPreset ? { agentPreset } : {}),
            },
            ...(agentOptions ? { agentOptions } : {}),
            setup,
        });
        shared.stateByChat.set(chatId, { auto: handle });
        shared.chatByAgent.set(handle.agent.id, chatId);
        if (config.persistSessions !== false && shared.store) {
            shared.store.set(chatId, handle.agent.id);
        }
        ctx.logger.info(`feishu: 为飞书会话 ${chatId} 创建专属 DSH agent（session ${handle.agent.id}，model ${model ?? '?'}）`);
        // 把新会话归入 workspace 工作区，避免显示在「未分组」里。
        void attachToWorkspace(ctx, handle.agent.id, config.workspace ?? process.cwd());
        return { ok: true, agent: handle.agent };
    }
    catch (error) {
        ctx.logger.error('feishu: 创建 DSH agent 失败', error);
        return { ok: false, message: '（创建 DSH agent 会话失败，请查看 dsh 日志）' };
    }
}
/** agent 模式：把消息转交给 DSH agent，输出流式转发到飞书。 */
async function agentReply(ctx, service, config, shared, msg, text) {
    const agents = ctx.get('agents');
    const resolved = await resolveAgent(ctx, config, shared, msg.chatId);
    if (!resolved.ok) {
        await safeReply(ctx, service, msg, resolved.message);
        return;
    }
    const agent = resolved.agent;
    if (!agents || !isLiveAgent(agents, agent)) {
        ctx.logger.warn(`feishu: agent ${agent.id} 已被销毁，忽略本条消息`);
        const state = shared.stateByChat.get(msg.chatId);
        if (state !== undefined && state.bound?.id === agent.id)
            state.bound = undefined;
        await safeReply(ctx, service, msg, '（agent 会话已被销毁，请重新发送消息以新建会话）');
        return;
    }
    // 会话被激活：若曾被用户归档，自动取消归档（恢复在工作区树显示）。
    void unarchiveIfNeeded(ctx, agent.id);
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    // 任务执行中：steer 在下一个 step 边界消费，agent 会先回应再继续任务；
    // 回应通过流式实时转发，遇到下一个工具调用即收尾。
    if (agent.status === 'running') {
        // 接管前收尾被替换 relay 的原生流式（占位卡/流式中卡片，避免悬挂）。
        closeOrphanStream(shared.relays.get(agent.id));
        const relay = { chatId: msg.chatId, agentId: agent.id, text: '', stopOnToolCall: true, cardMode: false, extraSegments: 0, segmentChars: config.segmentChars ?? 8000 };
        shared.relays.set(agent.id, relay);
        agent.steer(message);
        await safeReply(ctx, service, msg, '📥 已收到。当前任务执行中，我会在任务的下一个节点回应你。');
        return;
    }
    // 空闲：followup 启动一轮，输出全程流式。
    const relay = { chatId: msg.chatId, agentId: agent.id, text: '', stopOnToolCall: false, cardMode: false, extraSegments: 0, segmentChars: config.segmentChars ?? 8000 };
    shared.relays.set(agent.id, relay);
    // v0.6.7 占位卡片：回合开始即上屏（「收到，正在处理…」打字机卡片），
    // 工具执行期不再无声无息；首批文本到达后续写同一张卡（见 relayShowPlaceholder）。
    if (config.eagerPlaceholder !== false)
        relayShowPlaceholder(ctx, service, shared.relays, relay);
    agent.followup(message);
    await agent.whenIdle();
    await relayFlush(ctx, service, shared.relays, relay, true);
    if (relay.messageId === undefined) {
        ctx.logger.debug(`feishu: agent ${agent.id} 未产生文本输出`);
    }
}
/**
 * 队列忙碌（agent 长任务中）时的即时回应路径：不排队干等，直接把消息
 * steer 给正在运行的 agent（下一个 step 边界消费并流式回应）。
 * 仅当 agent 确实在 running 时生效；否则返回 false 走正常排队。
 */
async function trySteerRunning(ctx, service, config, shared, msg, text) {
    const agents = ctx.get('agents');
    if (!agents)
        return false;
    const state = shared.stateByChat.get(msg.chatId);
    let agent;
    if (state?.bound) {
        agent = isLiveAgent(agents, state.bound) ? state.bound : undefined;
    }
    else if (state?.auto) {
        agent = isLiveAgent(agents, state.auto.agent) ? state.auto.agent : undefined;
    }
    else if (config.agentId) {
        agent = agents.get(SessionId(config.agentId));
    }
    if (!agent || agent.status !== 'running')
        return false;
    shared.chatByAgent.set(agent.id, msg.chatId);
    // 会话被激活：若曾被用户归档，自动取消归档（恢复在工作区树显示）。
    void unarchiveIfNeeded(ctx, agent.id);
    // steer 接管前，先收尾被替换 relay 的原生流式占位卡（避免打字光标悬挂）。
    closeOrphanStream(shared.relays.get(agent.id));
    const relay = { chatId: msg.chatId, agentId: agent.id, text: '', stopOnToolCall: true, cardMode: false, extraSegments: 0, segmentChars: config.segmentChars ?? 8000 };
    shared.relays.set(agent.id, relay);
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await safeReply(ctx, service, msg, '📥 已收到。当前任务执行中，我会在任务的下一个节点回应你。');
    return true;
}
/** 飞书会话管理命令：返回 true 表示已拦截处理。 */
async function handleCommand(ctx, service, config, shared, msg, text) {
    if (config.commands === false)
        return false;
    const t = text.trim();
    if (!t.startsWith('/'))
        return false;
    const resetCommands = config.resetCommands ?? ['/new', '/reset'];
    // ── /new /reset：清空当前会话上下文 ─────────────────────────
    if (resetCommands.includes(t)) {
        shared.questions.cancelFor(msg.chatId); // 挂起的确认一并取消
        const state = shared.stateByChat.get(msg.chatId);
        if (state?.bound) {
            state.bound = undefined;
            shared.store?.delete(msg.chatId);
            await safeReply(ctx, service, msg, '✅ 已解除会话接手（未销毁目标会话）。下一条消息将自动创建新会话。');
        }
        else if (state?.auto) {
            const handle = state.auto;
            shared.stateByChat.delete(msg.chatId);
            shared.store?.delete(msg.chatId);
            await handle.dispose().catch((error) => {
                ctx.logger.warn('feishu: 销毁专属 agent 失败', error);
            });
            await safeReply(ctx, service, msg, '✅ 已开启新会话（上下文已清空），下一条消息将自动创建。');
        }
        else if (config.agentId) {
            await safeReply(ctx, service, msg, `（当前绑定的是配置的 agentId（${config.agentId}），属于 GUI 会话，不能销毁。如需换会话请用 /attach。）`);
        }
        else {
            // 无活跃会话（重启后 /new）：同样清除持久化映射——否则下一条消息
            // 会 resume 旧会话，用户以为开了新对话实则延续旧上下文（2026-09-02）。
            shared.store?.delete(msg.chatId);
            await safeReply(ctx, service, msg, '（当前没有活跃会话，已清除持久化映射；下一条消息将新建会话，上下文从零开始。）');
        }
        return true;
    }
    // ── /cancel：取消当前挂起的确认问题（agent 继续执行，不等回答）──
    if (t === '/cancel') {
        if (shared.questions.cancelFor(msg.chatId)) {
            await safeReply(ctx, service, msg, '✅ 已取消当前确认问题，agent 将继续执行。');
        }
        else {
            await safeReply(ctx, service, msg, '（当前没有待确认的问题。）');
        }
        return true;
    }
    // ── /sessions：列出活跃会话（可读） ──────────────────────────
    if (t === '/sessions') {
        const agents = ctx.get('agents');
        if (!agents) {
            await safeReply(ctx, service, msg, '（当前环境未加载 ctx.agents）');
            return true;
        }
        const bound = shared.stateByChat.get(msg.chatId)?.bound;
        const sessions = agents.roots();
        if (sessions.length === 0) {
            // 重启后常见场景：活跃会话为空但持久映射仍在——下一条消息会 resume
            // 映射会话。明确说出来，避免误以为「没有会话 = 下条会新建」。
            const mappedEmpty = shared.store?.get(msg.chatId);
            const hint = mappedEmpty
                ? `（当前没有活跃的 DSH agent 会话。注意：本会话的持久映射仍指向 ${shortSessionId(mappedEmpty)}，下一条消息将自动恢复它；发 /new 可清除映射、下一条即新建，或先在 GUI 打开一个会话再 /attach。）`
                : '（当前没有活跃的 DSH agent 会话。发 /attach <会话id> 可接手，或在 GUI 里打开一个会话。）';
            await safeReply(ctx, service, msg, hint);
            return true;
        }
        const lastList = [];
        const lines = sessions.map((agent, i) => {
            const index = i + 1;
            lastList.push({ index, id: agent.id });
            const title = sessionDisplayTitle(ctx, agent);
            const model = agent.options.model ?? agent.options.provider ?? '?';
            const cwd = agent.session.header.cwd ?? '?';
            const marker = agent.id === bound?.id ? ' ← 当前接手' : '';
            const tag = agent.id.startsWith('feishu-') ? '🤖飞书' : '💬';
            return `${tag} ${index}. ${title}\n    id=${agent.id} · ${model} · ${cwd}${marker}`;
        });
        const state = shared.stateByChat.get(msg.chatId) ?? {};
        state.lastList = lastList;
        shared.stateByChat.set(msg.chatId, state);
        // 状态透明化（v0.6.8）：本会话未接手时，说明下一条消息在自动模式下
        // 的真实去向（恢复映射会话 / 配置会话 / 新建），映射可对照上方 id。
        const mapped = shared.store?.get(msg.chatId);
        const bindLine = bound
            ? `📎 当前接手 ${shortSessionId(bound.id)}（消息直接驱动它）`
            : config.agentId
                ? `📎 未接手 · 下一条消息将使用配置的会话 ${config.agentId}`
                : mapped
                    ? `📎 未接手 · 下一条消息将自动恢复 ${shortSessionId(mapped)}（发 /new 可清除映射换新会话）`
                    : '📎 未接手 · 下一条消息将自动创建新会话';
        await safeReply(ctx, service, msg, `当前活跃会话（${sessions.length} 个）：\n${lines.join('\n')}\n\n${bindLine}\n用 /attach <编号或会话id> 接手（编号见上），/detach 解除。`);
        return true;
    }
    // ── /attach <编号或会话id>：接手 GUI 中某个既有会话 ──────────
    if (t === '/attach' || t.startsWith('/attach ')) {
        const agents = ctx.get('agents');
        if (!agents) {
            await safeReply(ctx, service, msg, '（当前环境未加载 ctx.agents）');
            return true;
        }
        const raw = t === '/attach' ? '' : t.slice('/attach '.length).trim();
        if (!raw) {
            await safeReply(ctx, service, msg, '用法：/attach <编号或会话id>（先用 /sessions 查看列表）');
            return true;
        }
        // 数字编号 → 最近一次 /sessions 列表中的会话
        let id = raw;
        if (/^\d+$/.test(raw)) {
            const state = shared.stateByChat.get(msg.chatId);
            const entry = state?.lastList?.find(item => item.index === Number(raw));
            if (!entry) {
                await safeReply(ctx, service, msg, `（没有编号 ${raw}。请先发 /sessions 获取最新列表。）`);
                return true;
            }
            id = entry.id;
        }
        const agent = agents.get(SessionId(id));
        if (!agent) {
            await safeReply(ctx, service, msg, `（未找到会话 ${id}。可用 /sessions 查看当前活跃会话。）`);
            return true;
        }
        // 接手被归档的会话时自动取消归档（恢复在工作区树显示）。
        void unarchiveIfNeeded(ctx, agent.id);
        const state = shared.stateByChat.get(msg.chatId) ?? {};
        state.bound = agent;
        shared.stateByChat.set(msg.chatId, state);
        ctx.logger.info(`feishu: 飞书会话 ${msg.chatId} 接手 DSH 会话 ${id}`);
        const title = sessionDisplayTitle(ctx, agent);
        await safeReply(ctx, service, msg, `✅ 已接手会话「${title}」（${id}）。此后的消息会直接驱动它，GUI 中也能看到。发 /detach 解除。`);
        // 状态透明化（v0.6.8）：接手目标 ≠ 持久映射时提醒——/detach 后消息会
        // 回到映射会话而非新建（2026-09-02 晚的误会场景）。
        const mappedOnAttach = shared.store?.get(msg.chatId);
        if (mappedOnAttach && mappedOnAttach !== agent.id) {
            await safeReply(ctx, service, msg, `📎 注意：本会话的持久映射仍指向 ${shortSessionId(mappedOnAttach)}，/detach 后下一条消息将自动恢复它。发 /new 可清除映射（此后自动新建）。`);
        }
        // 发送最近对话历史，便于接着对话（attachHistory 条，0 = 不发）。
        await sendRecentHistory(ctx, service, msg, agent, config.attachHistory ?? 5);
        return true;
    }
    // ── /detach：解除接手 ───────────────────────────────────────
    if (t === '/detach') {
        const state = shared.stateByChat.get(msg.chatId);
        if (state?.bound) {
            state.bound = undefined;
            // 状态透明化（v0.6.8）：如实告知下一条消息的去向。持久映射存在时
            // 自动模式 = 恢复映射会话（不是新建！）——2026-09-02 晚曾出现
            // 「/detach 后以为会开新会话，实际 resume 了白天会话」的误会。
            const mapped = shared.store?.get(msg.chatId);
            const next = config.agentId
                ? `下一条消息将使用配置的会话 ${config.agentId}。`
                : mapped
                    ? `下一条消息将自动恢复会话 ${shortSessionId(mapped)}（延续其上下文）；如需全新会话请先发 /new。`
                    : '下一条消息将自动创建新会话。';
            await safeReply(ctx, service, msg, `✅ 已解除接手。${next}`);
        }
        else {
            await safeReply(ctx, service, msg, '（当前没有接手的会话。）');
        }
        return true;
    }
    // ── 其他 / 命令：提示帮助，不转发给 agent ───────────────────
    await safeReply(ctx, service, msg, '可用命令：/new 或 /reset（新会话）· /sessions（列会话）· /attach <会话id>（接手）· /detach（解除）');
    return true;
}
/**
 * 订阅飞书长连接事件，按 config.mode 路由每条入站消息。
 * 每个会话内的消息串行处理，避免并发回复交错。
 */
export function attachInbound(ctx, service, config, shared) {
    replyFormat = config.replyFormat ?? 'markdown';
    const queues = new Map();
    const history = new Map();
    // ── 全局流式转发：agent 输出 → 飞书 ─────────────────────────
    // assistant/chunk（text-delta）实时刷新到飞书消息；steer 路径
    // （stopOnToolCall）在下一个工具调用时收尾。
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/chunk')
            return;
        const relay = shared.relays.get(session.id);
        if (!relay)
            return;
        const chunk = event.data.chunk;
        if (chunk.type === 'text-delta') {
            relayAppend(ctx, service, shared.relays, relay, chunk.text);
        }
        else if (chunk.type === 'tool-call-delta' && relay.stopOnToolCall) {
            relayEnd(ctx, service, shared.relays, relay);
        }
    });
    // agent 回到 idle 时收尾所有该 agent 的流式转发（兜底：steer 路径
    // 若 agent 不再调用工具而直接结束）。
    ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle')
            return;
        const relay = shared.relays.get(agent.id);
        if (relay)
            relayEnd(ctx, service, shared.relays, relay);
    });
    service.channel.on({
        message: (msg) => {
            const text = (msg.content ?? '').trim();
            if (!text)
                return; // 图片/文件等无文本消息：忽略
            // 1) 待确认问题：回复编号/选项标签 → 直接消费，不进 agent 队列
            //    （否则会排在等待回答的 agent 回合后面，形成死锁）。
            if (shared.questions.consumeTextAnswer(msg.chatId, text))
                return;
            // 2) 有挂起确认时：命令直通处理（/cancel 立即取消、/new 立即重置），
            //    其他文本提示后排队（问题回答/超时后作为普通消息处理）。
            if (shared.questions.hasPending(msg.chatId)) {
                if (text.startsWith('/')) {
                    void handleCommand(ctx, service, config, shared, msg, text)
                        .catch((error) => ctx.logger.warn('feishu: 处理命令异常', error));
                    return;
                }
                void safeReply(ctx, service, msg, '📌 当前有一个待确认问题，请先点击卡片按钮或回复编号回答；也可回复 /cancel 取消该问题。');
                enqueue(msg, text);
                return;
            }
            // 3) 队列忙碌（agent 长任务中）→ 即时 ack + steer，不排队干等；
            //    长任务期间的消息不再「石沉大海」。
            if (queues.has(msg.chatId)) {
                if (!text.startsWith('/')) {
                    void trySteerRunning(ctx, service, config, shared, msg, text)
                        .then((steered) => {
                        if (!steered)
                            enqueue(msg, text);
                    });
                    return;
                }
            }
            enqueue(msg, text);
        },
        reject: (evt) => {
            ctx.logger.debug(`feishu: 消息被策略拒绝（${evt.reason}）messageId=${evt.messageId}`);
        },
        error: (err) => {
            ctx.logger.error(`feishu: 长连接错误 [${err.code}] ${err.message}`);
        },
        reconnecting: () => {
            ctx.logger.warn('feishu: 长连接断开，正在自动重连…');
        },
        reconnected: () => {
            ctx.logger.info('feishu: 长连接已重连');
        },
        botAdded: (evt) => {
            ctx.logger.info(`feishu: 机器人被添加到会话 ${evt.chatId}`);
        },
    });
    /** 每条消息串行处理（按 chatId），避免并发回复交错。 */
    function enqueue(msg, text) {
        const run = (queues.get(msg.chatId) ?? Promise.resolve())
            .then(() => handleMessage(ctx, service, config, history, shared, msg, text))
            .catch((error) => ctx.logger.warn('feishu: 处理入站消息异常', error));
        queues.set(msg.chatId, run);
        void run.finally(() => {
            if (queues.get(msg.chatId) === run)
                queues.delete(msg.chatId);
        });
    }
}
async function handleMessage(ctx, service, config, history, shared, msg, text) {
    if (!text)
        return; // 图片/文件等无文本消息：忽略
    // 会话管理命令优先（/new /sessions /attach /detach /cancel）
    if (await handleCommand(ctx, service, config, shared, msg, text))
        return;
    switch (config.mode ?? 'llm') {
        case 'echo':
            await safeReply(ctx, service, msg, `收到：${text}`);
            return;
        case 'agent':
            await agentReply(ctx, service, config, shared, msg, text);
            return;
        case 'llm':
        default:
            await llmReply(ctx, service, config, history, msg, text);
    }
}
//# sourceMappingURL=inbound.js.map