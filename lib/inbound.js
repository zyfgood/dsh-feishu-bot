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
/** 流式转发到飞书的节流间隔（ms）：飞书消息编辑有限频，聚合后批量更新。 */
const STREAM_FLUSH_MS = 400;
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
 *  首选原生卡片流式（cardkit 打字机效果，只传增量）；启动/更新失败或
 *  text 排版模式时降级为「首条卡片/文本 + 后续编辑更新」的旧链路。 */
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
            relay.streamDone?.resolve(); // 兜底：让已启动的流式正常收尾
            relays.delete(relay.agentId);
        }
        return;
    }
    // ── 原生卡片流式：已启动 → 只传增量；收尾/熔断时结束 ─────────
    if (relay.streamRun !== undefined && !relay.streamFailed) {
        if (relay.streamController !== undefined && text !== '') {
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
        if (final || relay.tripped) {
            relay.streamDone?.resolve();
            try {
                const result = await relay.streamRun;
                relay.messageId = result.messageId;
            }
            catch {
                // 启动失败已由下方 .catch 降级路径接管，这里只收尾。
            }
            relays.delete(relay.agentId);
        }
        return;
    }
    // ── 原生卡片流式：未启动（首刷）→ 启动占位卡片 ──────────────
    if (!relay.streamFailed && replyFormat === 'markdown') {
        let resolveDone;
        const done = new Promise((res) => { resolveDone = res; });
        relay.streamDone = { promise: done, resolve: resolveDone };
        relay.streamRun = service.streamMarkdown(relay.chatId, async (controller) => {
            relay.streamController = controller;
            // 种子：启动前已累积的文本；后续内容由各次 flush 增量推送。
            if (relay.text.trim() !== '')
                await controller.setContent(relay.text.trim());
            await done;
        });
        // 正常结束：回填 messageId（统计/日志用）。
        relay.streamRun.then((result) => { relay.messageId = result.messageId; }).catch(() => { });
        // 启动失败（缺 cardkit 权限等）→ 降级旧链路重发普通卡片。
        relay.streamRun.catch((error) => {
            relay.streamFailed = true;
            relay.streamController = undefined;
            ctx.logger.warn('feishu: 原生卡片流式启动失败，降级为普通卡片流式', error);
            void relayFlush(ctx, service, relays, relay, false);
        });
        if (final || relay.tripped) {
            relay.streamDone?.resolve();
            try {
                const result = await relay.streamRun;
                relay.messageId = result.messageId;
            }
            catch {
                // 降级路径接管发送。
            }
            relays.delete(relay.agentId);
        }
        return;
    }
    // ── 旧链路（原生流式降级 / text 排版模式）────────────────────
    try {
        if (relay.messageId === undefined) {
            if (replyFormat === 'markdown') {
                const result = await service.sendMarkdownCard(relay.chatId, text);
                relay.messageId = result.messageId;
                relay.cardMode = true;
            }
            else {
                const result = await service.send(relay.chatId, { text });
                relay.messageId = result.messageId;
                relay.cardMode = false;
            }
        }
        else if (relay.cardMode) {
            await service.updateMarkdownCard(relay.messageId, text);
        }
        else {
            await service.channel.editMessage(relay.messageId, text);
        }
    }
    catch (error) {
        ctx.logger.warn('feishu: 流式刷新消息失败（卡片降级为纯文本续流）', error);
        if (relay.cardMode) {
            // 卡片发送/更新失败：降级为纯文本流式（重发一条文本，后续走 editMessage）。
            relay.cardMode = false;
            relay.messageId = undefined;
            try {
                const result = await service.send(relay.chatId, { text });
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
/** 解析目标 agent：attach 绑定 > 配置 agentId > 自动创建/复用。 */
async function resolveAgent(ctx, config, stateByChat, chatId) {
    const agents = ctx.get('agents');
    if (!agents) {
        return { ok: false, message: '（当前环境未加载 ctx.agents，无法使用 agent 模式）' };
    }
    const state = stateByChat.get(chatId);
    // 1) /attach 接手的目标会话优先
    if (state?.bound) {
        if (isLiveAgent(agents, state.bound))
            return { ok: true, agent: state.bound };
        state.bound = undefined; // 目标已被销毁，解除绑定
    }
    // 2) 配置的 agentId
    if (config.agentId) {
        const agent = agents.get(SessionId(config.agentId));
        if (!agent) {
            return { ok: false, message: `（未找到 agent 会话 ${config.agentId}，请先配置或使用 /attach）` };
        }
        return { ok: true, agent };
    }
    // 3) 自动创建/复用专属会话
    if (state?.auto && isLiveAgent(agents, state.auto.agent)) {
        return { ok: true, agent: state.auto.agent };
    }
    if (state?.auto)
        state.auto = undefined;
    try {
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
        // agent preset：解析 preset 并在 setup 中挂载，与 GUI 新建会话一致
        // （apiproxy 同款做法）。不挂载的话 agent 只有全局工具（SSH/飞书/图片
        // 识别），缺少 bash/文件/技能等 preset 内注册的工具。
        const agentPresets = ctx.get('agentPresets');
        let agentPreset;
        let presetSetup;
        if (agentPresets) {
            const requested = config.agentPreset ?? agentPresets.defaultId;
            try {
                const resolved = await agentPresets.resolve(requested);
                agentPreset = resolved.id;
                presetSetup = async (agentCtx) => {
                    try {
                        await agentPresets.mount(agentCtx, resolved.id);
                    }
                    catch (error) {
                        // 挂载失败不阻断创建：降级为全局工具，但记清楚日志便于排查。
                        ctx.logger.error(`feishu: preset "${resolved.id}" 挂载失败，该 agent 将使用全局工具运行`, error);
                    }
                };
            }
            catch (error) {
                ctx.logger.warn(`feishu: 解析 agent preset "${requested}" 失败，agent 将使用全局工具运行`, error);
            }
        }
        const handle = await agents.create({
            sessionId: SessionId(`feishu-${chatId}-${randomUUID().slice(0, 8)}`),
            meta: {
                cwd: config.workspace ?? process.cwd(),
                ...(agentPreset ? { agentPreset } : {}),
            },
            ...(agentOptions ? { agentOptions } : {}),
            ...(presetSetup ? { setup: presetSetup } : {}),
        });
        stateByChat.set(chatId, { auto: handle });
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
async function agentReply(ctx, service, config, stateByChat, relays, msg, text) {
    const agents = ctx.get('agents');
    const resolved = await resolveAgent(ctx, config, stateByChat, msg.chatId);
    if (!resolved.ok) {
        await safeReply(ctx, service, msg, resolved.message);
        return;
    }
    const agent = resolved.agent;
    if (!agents || !isLiveAgent(agents, agent)) {
        ctx.logger.warn(`feishu: agent ${agent.id} 已被销毁，忽略本条消息`);
        const state = stateByChat.get(msg.chatId);
        if (state !== undefined && state.bound?.id === agent.id)
            state.bound = undefined;
        await safeReply(ctx, service, msg, '（agent 会话已被销毁，请重新发送消息以新建会话）');
        return;
    }
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    // 任务执行中：steer 在下一个 step 边界消费，agent 会先回应再继续任务；
    // 回应通过流式实时转发，遇到下一个工具调用即收尾。
    if (agent.status === 'running') {
        const relay = { chatId: msg.chatId, agentId: agent.id, text: '', stopOnToolCall: true, cardMode: false };
        relays.set(agent.id, relay);
        agent.steer(message);
        await safeReply(ctx, service, msg, '📥 已收到。当前任务执行中，我会在任务的下一个节点回应你。');
        return;
    }
    // 空闲：followup 启动一轮，输出全程流式。
    const relay = { chatId: msg.chatId, agentId: agent.id, text: '', stopOnToolCall: false, cardMode: false };
    relays.set(agent.id, relay);
    agent.followup(message);
    await agent.whenIdle();
    await relayFlush(ctx, service, relays, relay, true);
    if (relay.messageId === undefined) {
        ctx.logger.debug(`feishu: agent ${agent.id} 未产生文本输出`);
    }
}
/** 飞书会话管理命令：返回 true 表示已拦截处理。 */
async function handleCommand(ctx, service, config, stateByChat, msg, text) {
    if (config.commands === false)
        return false;
    const t = text.trim();
    if (!t.startsWith('/'))
        return false;
    const resetCommands = config.resetCommands ?? ['/new', '/reset'];
    // ── /new /reset：清空当前会话上下文 ─────────────────────────
    if (resetCommands.includes(t)) {
        const state = stateByChat.get(msg.chatId);
        if (state?.bound) {
            state.bound = undefined;
            await safeReply(ctx, service, msg, '✅ 已解除会话接手（未销毁目标会话）。下一条消息将自动创建新会话。');
        }
        else if (state?.auto) {
            const handle = state.auto;
            stateByChat.delete(msg.chatId);
            await handle.dispose().catch((error) => {
                ctx.logger.warn('feishu: 销毁专属 agent 失败', error);
            });
            await safeReply(ctx, service, msg, '✅ 已开启新会话（上下文已清空），下一条消息将自动创建。');
        }
        else if (config.agentId) {
            await safeReply(ctx, service, msg, `（当前绑定的是配置的 agentId（${config.agentId}），属于 GUI 会话，不能销毁。如需换会话请用 /attach。）`);
        }
        else {
            await safeReply(ctx, service, msg, '（当前还没有会话，下一条消息将自动创建。）');
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
        const bound = stateByChat.get(msg.chatId)?.bound;
        const sessions = agents.roots();
        if (sessions.length === 0) {
            await safeReply(ctx, service, msg, '（当前没有活跃的 DSH agent 会话。发 /attach <会话id> 可接手，或在 GUI 里打开一个会话。）');
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
        const state = stateByChat.get(msg.chatId) ?? {};
        state.lastList = lastList;
        stateByChat.set(msg.chatId, state);
        await safeReply(ctx, service, msg, `当前活跃会话（${sessions.length} 个）：\n${lines.join('\n')}\n\n用 /attach <编号或会话id> 接手（编号见上），/detach 解除。`);
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
            const state = stateByChat.get(msg.chatId);
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
        const state = stateByChat.get(msg.chatId) ?? {};
        state.bound = agent;
        stateByChat.set(msg.chatId, state);
        ctx.logger.info(`feishu: 飞书会话 ${msg.chatId} 接手 DSH 会话 ${id}`);
        const title = sessionDisplayTitle(ctx, agent);
        await safeReply(ctx, service, msg, `✅ 已接手会话「${title}」（${id}）。此后的消息会直接驱动它，GUI 中也能看到。发 /detach 解除。`);
        // 发送最近对话历史，便于接着对话（attachHistory 条，0 = 不发）。
        await sendRecentHistory(ctx, service, msg, agent, config.attachHistory ?? 5);
        return true;
    }
    // ── /detach：解除接手 ───────────────────────────────────────
    if (t === '/detach') {
        const state = stateByChat.get(msg.chatId);
        if (state?.bound) {
            state.bound = undefined;
            await safeReply(ctx, service, msg, '✅ 已解除接手，回到自动创建模式。');
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
export function attachInbound(ctx, service, config) {
    replyFormat = config.replyFormat ?? 'markdown';
    const queues = new Map();
    const history = new Map();
    const stateByChat = new Map();
    const relays = new Map();
    // ── 全局流式转发：agent 输出 → 飞书 ─────────────────────────
    // assistant/chunk（text-delta）实时刷新到飞书消息；steer 路径
    // （stopOnToolCall）在下一个工具调用时收尾。
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/chunk')
            return;
        const relay = relays.get(session.id);
        if (!relay)
            return;
        const chunk = event.data.chunk;
        if (chunk.type === 'text-delta') {
            relayAppend(ctx, service, relays, relay, chunk.text);
        }
        else if (chunk.type === 'tool-call-delta' && relay.stopOnToolCall) {
            relayEnd(ctx, service, relays, relay);
        }
    });
    // agent 回到 idle 时收尾所有该 agent 的流式转发（兜底：steer 路径
    // 若 agent 不再调用工具而直接结束）。
    ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle')
            return;
        const relay = relays.get(agent.id);
        if (relay)
            relayEnd(ctx, service, relays, relay);
    });
    service.channel.on({
        message: (msg) => {
            const run = (queues.get(msg.chatId) ?? Promise.resolve())
                .then(() => handleMessage(ctx, service, config, history, stateByChat, relays, msg))
                .catch((error) => ctx.logger.warn('feishu: 处理入站消息异常', error));
            queues.set(msg.chatId, run);
            void run.finally(() => {
                if (queues.get(msg.chatId) === run)
                    queues.delete(msg.chatId);
            });
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
}
async function handleMessage(ctx, service, config, history, stateByChat, relays, msg) {
    const text = (msg.content ?? '').trim();
    if (!text)
        return; // 图片/文件等无文本消息：忽略
    // 会话管理命令优先（/new /sessions /attach /detach）
    if (await handleCommand(ctx, service, config, stateByChat, msg, text))
        return;
    switch (config.mode ?? 'llm') {
        case 'echo':
            await safeReply(ctx, service, msg, `收到：${text}`);
            return;
        case 'agent':
            await agentReply(ctx, service, config, stateByChat, relays, msg, text);
            return;
        case 'llm':
        default:
            await llmReply(ctx, service, config, history, msg, text);
    }
}
//# sourceMappingURL=inbound.js.map