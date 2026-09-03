#!/usr/bin/env node
/**
 * dsh-feishu-bot 冒烟测试：用 mock 上下文跑通核心链路。
 *
 * 用法：npm test  或  node tests/smoke.mjs
 *
 * 覆盖：模块导出、Config 校验、env: 密钥、echo / llm / agent 三种模式、
 * 自动创建会话与复用、/new 重置、/sessions 可读列表与编号 /attach、
 * 新会话自动归入工作区。
 */

import assert from 'node:assert/strict'
import { apply, Config, resolveSecret } from '../lib/index.js'

let passed = 0
const ok = (name) => { passed++; console.log(`  ✓ ${name}`) }

/** 构造 mock 上下文；fakeServices 可按需注入 agents/llm/tools/sessionTitle/workspaceRegistry。 */
function makeCtx(fakeServices = {}) {
  const listeners = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    reflect: { provide: (name, inst) => { ctx[name] = inst } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') d(); return d },
    get: (name) => fakeServices[name],
    on: (name, fn) => {
      ;(listeners[name] ??= []).push(fn)
      return () => {
        const arr = listeners[name]
        if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1) }
      }
    },
    emit: (name, ...args) => { for (const fn of [...(listeners[name] ?? [])]) fn(...args) },
  }
  return { ctx, listeners }
}

/** 造一个假 agent（可注入标题事件、可驱动）。 */
function makeAgent(id, cwd, model = 'deepseek-v4-flash') {
  let seq = 0
  const events = []
  const agent = {
    id,
    status: 'idle',
    steered: [],
    options: { provider: 'deepseek-official', model },
    session: { get seq() { return seq }, events, header: { id, cwd } },
    followup() {
      events.push({ seq: ++seq, type: 'user/message', data: {} })
      events.push({ seq: ++seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `reply-from-${id}` }] } } })
    },
    steer(m) { this.steered.push(m); this.status = 'running' },
    whenIdle: async () => {},
  }
  return agent
}

function makeAgentsRegistry(initial = []) {
  const live = new Map(initial.map(a => [a.id, a]))
  return {
    get: (id) => live.get(id),
    list: () => [...live.values()],
    roots: () => [...live.values()],
    create: async (opts) => {
      const a = makeAgent(opts.sessionId, opts.meta?.cwd, opts.agentOptions?.model)
      live.set(a.id, a)
      if (opts.setup) await opts.setup({ agent: a }) // 模拟 agent-loop 的 setupAndPublish
      return { agent: a, dispose: () => { live.delete(a.id); return Promise.resolve() } }
    },
  }
}

function makeFakeLlm(replyText = '你好，我是 LLM 自动回复！') {
  return {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: replyText }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** 装载插件 + 桩住发送，返回 { ctx, send, handler }。 */
async function boot(configRaw, fakeServices = {}) {
  const cfg = Config['~standard'].validate(configRaw)
  assert.equal(cfg.issues, undefined, `config 校验失败: ${JSON.stringify(cfg.issues)}`)
  const { ctx, listeners } = makeCtx(fakeServices)
  apply(ctx, cfg.value)
  const channel = ctx.feishu.channel
  const send = []
  channel.send = async (to, input, opts) => { send.push({ to, input, opts }); return { messageId: `om_${send.length}` } }
  channel.editMessage = async (messageId, text) => { send.push({ to: 'EDIT', editMessageId: messageId, input: { text }, opts: undefined }) }
  channel.updateCard = async (messageId, card) => { send.push({ to: 'EDIT-CARD', editMessageId: messageId, input: { card }, opts: undefined }) }
  // 原生卡片流式：producer 驱动 controller（append/setContent 记入 send），结束后返回 messageId。
  channel.stream = async (to, input) => {
    const producer = input.markdown
    const controller = {
      _messageId: `om_stream_${send.length + 1}`,
      get messageId() { return this._messageId },
      append: async (chunk) => { send.push({ to, input: { card: { body: { elements: [{ tag: 'markdown', content: chunk }] } } }, opts: undefined }) },
      setContent: async (full) => { send.push({ to, input: { card: { body: { elements: [{ tag: 'markdown', content: full }] } } }, opts: undefined }) },
    }
    await producer(controller)
    return { messageId: controller.messageId }
  }
  const handler = channel['handlers'].message
  return { ctx, listeners, send, handler }
}

/** 提取一条发送记录的文本：支持纯文本、markdown（post）与 markdown 卡片。 */
const textOf = (input) => {
  if (!input) return ''
  if (typeof input.text === 'string') return input.text
  if (typeof input.markdown === 'string') return input.markdown
  const card = input.card
  if (card && Array.isArray(card.body?.elements)) {
    return card.body.elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n')
  }
  return ''
}
const reply = (send) => textOf(send[send.length - 1]?.input)

// ── 1. 模块导出 ──────────────────────────────────────────────
console.log('1) 模块导出')
assert.ok(apply && Config && resolveSecret, '缺少导出')
ok('apply/Config/resolveSecret 均已导出')

// ── 2. Config 校验 ───────────────────────────────────────────
console.log('2) Config 校验')
{
  const std = Config['~standard']
  const v = std.validate({ appId: 'cli_x', appSecret: 's' }).value
  assert.equal(v.mode, 'llm')
  assert.equal(v.requireMention, true)
  assert.equal(v.tools, true)
  assert.equal(v.domain, 'feishu')
  ok('默认值生效')
  assert.equal(std.validate({ appSecret: 's' }).issues?.length, 1)
  assert.equal(std.validate({ appId: 'a', appSecret: 'b', mode: 'nope' }).issues?.length, 1)
  ok('必填项/非法枚举校验')
}

// ── 3. env: 密钥 ─────────────────────────────────────────────
console.log('3) env: 密钥解析')
{
  process.env.FS_TEST_SECRET = 's3cret'
  assert.equal(resolveSecret('env:FS_TEST_SECRET'), 's3cret')
  assert.throws(() => resolveSecret('env:FS_MISSING_VAR'))
  ok('env: 读取与缺失报错')
}

// ── 4. echo 模式 ─────────────────────────────────────────────
console.log('4) echo 模式')
{
  const { send, handler } = await boot({ appId: 'cli_x', appSecret: 's', mode: 'echo', tools: false })
  await handler({ chatId: 'oc_1', messageId: 'om_1', content: '你好飞书', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(reply(send), '收到：你好飞书')
  assert.equal(send[0]?.opts?.replyTo, 'om_1')
  ok('回显并引用原消息')
}

// ── 5. llm 模式 ──────────────────────────────────────────────
console.log('5) llm 模式')
{
  const { send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'llm', provider: 'deepseek-official', model: 'deepseek-v4-flash', tools: false },
    { llm: makeFakeLlm() },
  )
  await handler({ chatId: 'oc_2', messageId: 'om_2', content: '天气如何', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(reply(send), '你好，我是 LLM 自动回复！')
  ok('调用 ctx.llm 并回复')
}

// ── 6. agent 模式：自动创建 + 复用 ───────────────────────────
console.log('6) agent 模式自动创建/复用')
{
  const agents = makeAgentsRegistry()
  const attached = []
  const { listeners, send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    {
      agents,
      workspaceRegistry: {
        resolveByPath: async () => ({ attachSession: async (id) => { attached.push(id) } }),
        create: async () => ({ attachSession: async (id) => { attached.push(id) } }),
      },
    },
  )
  await handler({ chatId: 'oc_3', messageId: 'om_3', content: '帮我写脚本', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  const createdAfterFirst = agents.roots().length
  await handler({ chatId: 'oc_3', messageId: 'om_4', content: '再优化', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(agents.roots().length, createdAfterFirst, '同一会话第二条消息应复用而非新建')
  ok('自动创建并复用（只建 1 个）')
  assert.ok(attached.length >= 1, '新会话应自动归入工作区')
  ok('新会话自动 attachSession 到工作区')
}

// ── 7. /new 重置 ─────────────────────────────────────────────
console.log('7) /new 重置')
{
  const agents = makeAgentsRegistry()
  const { send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents },
  )
  await handler({ chatId: 'oc_4', messageId: 'om_5', content: 'hi', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  const n1 = agents.roots().length
  await handler({ chatId: 'oc_4', messageId: 'om_6', content: '/new', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(agents.roots().length, n1 - 1, '/new 应销毁专属 agent')
  assert.ok(reply(send).includes('已开启新会话'))
  ok('/new 销毁会话并确认')
}

// ── 8. /sessions 可读列表 + 编号 /attach ─────────────────────
console.log('8) /sessions + /attach 编号')
{
  const gui = makeAgent('session-gui-777', '/mnt/d/DSHProjects/projA', 'deepseek-v4-pro')
  gui.session.events.push({ seq: 1, type: 'session/title', data: { title: '帮我重构登录模块' } })
  const agents = makeAgentsRegistry([gui, makeAgent('feishu-oc_5-abc12345', '/mnt/d/DSHProjects')])
  const { send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, sessionTitle: { get: (s) => s.events.findLast(e => e.type === 'session/title')?.data } },
  )
  await handler({ chatId: 'oc_5', messageId: 'om_7', content: '/sessions', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  const list = reply(send)
  assert.ok(list.includes('帮我重构登录模块'), '应显示会话标题')
  assert.ok(list.includes('1.') && list.includes('2.'), '应带编号')
  assert.ok(list.includes('deepseek-v4-pro'), '应显示模型')
  ok('/sessions 输出标题/编号/模型')
  await handler({ chatId: 'oc_5', messageId: 'om_8', content: '/attach 1', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  assert.ok(reply(send).includes('已接手会话「帮我重构登录模块」'), '按编号接手')
  await handler({ chatId: 'oc_5', messageId: 'om_9', content: '继续', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(gui.session.events.filter(e => e.type === 'user/message').length, 1, '消息应 followup 给被接手会话')
  ok('/attach 编号选择并驱动')
}

// ── 9. 标准 agent preset ────────────────────────────────────
console.log('9) 标准 agent preset')
{
  let createdMeta = null
  const setupCalls = []
  const agents = makeAgentsRegistry()
  const realCreate = agents.create
  agents.create = async (opts) => {
    createdMeta = opts.meta
    if (opts.setup) {
      const original = opts.setup
      opts.setup = async (agentCtx) => { await original(agentCtx); setupCalls.push('setup') }
    }
    return realCreate(opts)
  }
  const { handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    {
      agents,
      agentPresets: {
        defaultId: 'standard',
        resolve: async (id) => ({ id: id ?? 'standard' }),
        mount: async (_agentCtx, id) => { setupCalls.push(`mount:${id}`) },
      },
    },
  )
  await handler({ chatId: 'oc_9', messageId: 'om_9', content: '你好', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(createdMeta?.agentPreset, 'standard', 'header 应记录 agentPreset=standard')
  assert.ok(setupCalls.includes('setup') && setupCalls.includes('mount:standard'), 'setup 应调用 presets.mount 挂载工具')
  ok('创建 agent 带 agentPreset 且在 setup 中挂载 preset')
}

// ── 10. 流式输出（idle → followup 全程实时转发） ──────────────
console.log('10) 流式输出')
{
  const agents = makeAgentsRegistry()
  const { listeners, send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  // 让 followup 触发流式 chunk（模拟 agent 输出）
  const agentRef = { current: null }
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    agentRef.current = h.agent
    const origFollowup = h.agent.followup.bind(h.agent)
    h.agent.followup = () => {
      origFollowup()
      // 模拟 agent 流式输出两个文本块
      listeners['session/event']?.forEach(fn => fn({ id: h.agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '你好，我' } } }))
      listeners['session/event']?.forEach(fn => fn({ id: h.agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '是流式输出！' } } }))
    }
    return h
  }
  await handler({ chatId: 'oc_10', messageId: 'om_10', content: '测试流式', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 700)) // 等待节流刷新
  const sentTexts = send.map(s => textOf(s.input)).filter(Boolean)
  assert.ok(sentTexts.length >= 1, '应有流式消息发出')
  assert.equal(sentTexts[sentTexts.length - 1], '你好，我是流式输出！', '最终文本完整')
  assert.ok(send.every(s => s.to !== 'EDIT' && s.to !== 'EDIT-CARD'), '原生流式应走 channel.stream，而非旧编辑链路')
  ok('流式输出：原生卡片流式（占位卡 + 增量上屏）')
}

// ── 10b. 原生流式：多次节流刷新只更新同一卡片，不新增消息 ──────
console.log('10b) 原生流式增量刷新')
{
  const agents = makeAgentsRegistry()
  const { listeners, send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    const origFollowup = h.agent.followup.bind(h.agent)
    // 让 agent 保持运行 ~1.2s，覆盖多个节流窗口，模拟真实流式节奏
    h.agent.whenIdle = async () => { await new Promise(r => setTimeout(r, 1200)) }
    h.agent.followup = () => {
      origFollowup()
      // 模拟 agent 流式输出，分多次（跨节流窗口）
      const emit = (t) => listeners['session/event']?.forEach(fn => fn({ id: h.agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: t } } }))
      emit('第一段。')
      setTimeout(() => emit('第二段。'), 100)
      setTimeout(() => emit('第三段，结束。'), 500)
    }
    return h
  }
  await handler({ chatId: 'oc_10b', messageId: 'om_10b', content: '多段流式', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 1300)) // 覆盖多个节流窗口 + 收尾
  const streamCalls = send.filter(s => s.to !== 'EDIT' && s.to !== 'EDIT-CARD')
  const texts = streamCalls.map(s => textOf(s.input)).filter(Boolean)
  assert.ok(texts.length >= 2, `应有多次增量刷新（实际 ${texts.length}）`)
  assert.equal(texts[texts.length - 1], '第一段。第二段。第三段，结束。', '最终内容完整且只更新同一卡片')
  ok('原生流式：多次刷新更新同一卡片，最终文本完整')
}

// ── 11. 任务执行中回应（running → steer + 流式收尾） ──────────
console.log('11) 任务执行中回应')
{
  const agents = makeAgentsRegistry()
  const { listeners, send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  let live = null
  const realCreate = agents.create
  agents.create = async (opts) => { const h = await realCreate(opts); live = h.agent; return h }
  await handler({ chatId: 'oc_11', messageId: 'om_11', content: '跑个任务', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  // 模拟 agent 正在执行任务（GUI 任务驱动）
  live.status = 'running'
  await handler({ chatId: 'oc_11', messageId: 'om_12', content: '现在进度如何？', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(live.steered.length, 1, 'running 时应 steer 而非 followup')
  assert.ok(reply(send).includes('📥 已收到'), '应回确认消息')
  // agent 在下一节点回应（流式），然后继续任务（tool-call）→ 收尾
  listeners['session/event']?.forEach(fn => fn({ id: live.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '进度 50%，' } } }))
  listeners['session/event']?.forEach(fn => fn({ id: live.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '马上好。' } } }))
  await new Promise(r => setTimeout(r, 700))
  listeners['session/event']?.forEach(fn => fn({ id: live.id }, { type: 'assistant/chunk', data: { chunk: { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'bash', argumentsDelta: '' } } }))
  await new Promise(r => setTimeout(r, 50))
  const sentTexts = send.map(s => textOf(s.input)).filter(Boolean)
  assert.ok(sentTexts.some(t => t.includes('进度 50%')), '任务中回应应流式转发')
  ok('任务执行中：steer 注入 + 流式回应 + 工具调用时收尾')
}


// ── 12. /attach 后发送最近历史 ───────────────────────────────
console.log('12) /attach 发送最近历史')
{
  const gui = makeAgent('session-gui-888', '/mnt/d/DSHProjects/projA', 'deepseek-v4-pro')
  // 构造历史：3 条 user + 2 条 assistant
  gui.session.events.push(
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看项目' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，已看到项目结构。' }] } } },
    { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '这个模块怎么改？' }] } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '建议用工厂模式重构。' }] } } },
    { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: '有道理' }] } },
  )
  gui.session.events.push({ seq: 6, type: 'session/title', data: { title: '项目重构讨论' } })
  const agents = makeAgentsRegistry([gui])
  const { send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false, attachHistory: 3 },
    { agents, sessionTitle: { get: (s) => s.events.findLast(e => e.type === 'session/title')?.data } },
  )
  await handler({ chatId: 'oc_12', messageId: 'om_13', content: '/attach session-gui-888', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  const texts = send.map(s => textOf(s.input))
  const historyMsg = texts.find(t => t.includes('📜 最近对话'))
  assert.ok(historyMsg, '应发送历史消息')
  assert.ok(historyMsg.includes('👤 我：这个模块怎么改？'), '历史应包含最近的用户消息')
  assert.ok(historyMsg.includes('🤖 助手：建议用工厂模式重构。'), '历史应包含最近的助手回复')
  assert.ok(historyMsg.includes('👤 我：有道理'), '最近 3 条应包含最新消息')
  assert.ok(!historyMsg.includes('帮我看看项目'), '最近 3 条不应包含最旧消息')
  ok('/attach 发送最近 3 条历史（不含最旧）')
}


// ── 13. feishu_push 推送到目标群 ─────────────────────────────
console.log('13) feishu_push 推送到目标群')
{
  const regs = new Map()
  const fakeTools = { register: (t) => { regs.set(t.name, t); return () => {} } }
  const { ctx } = makeCtx({ tools: fakeTools })
  apply(ctx, Config['~standard'].validate({ appId: 'a', appSecret: 's', mode: 'echo', pushChatId: 'oc_push_group' }).value)
  const pushed = []
  ctx.feishu.channel.send = async (to, input) => { pushed.push({ to, input }); return { messageId: 'om_p1' } }
  const r = await regs.get('feishu_push').execute({ content: '📋 任务完成\n- 要点1' }, {})
  assert.equal(r.pushed, true)
  assert.equal(r.chat_id, 'oc_push_group')
  assert.equal(pushed[0].to, 'oc_push_group')
  assert.equal(pushed[0].input.text, '📋 任务完成\n- 要点1')
  ok('feishu_push 推送到配置的目标群')
  // 未配置时给出明确提示
  const regs2 = new Map()
  const ctx2 = makeCtx({ tools: { register: (t) => { regs2.set(t.name, t); return () => {} } } }).ctx
  apply(ctx2, Config['~standard'].validate({ appId: 'a', appSecret: 's', mode: 'echo' }).value)
  const r2 = await regs2.get('feishu_push').execute({ content: 'x' }, {})
  assert.equal(r2.pushed, false)
  assert.ok(r2.detail.includes('pushChatId'))
  ok('未配置 pushChatId 时给出提示')
}


// ── 14. 复读熔断 detectTailRepetition ────────────────────────
console.log('14) 复读熔断 detectTailRepetition')
{
  const { detectTailRepetition } = await import('../lib/inbound.js')

  // 事故特征：长单元（总结段落）连续重复 → 命中
  const unit = '总结：本次任务已完成。\n\n检查结果：一致。\n\n'
  const looped = `前置正常内容。\n\n${unit.repeat(80)}`
  const hit = detectTailRepetition(looped)
  assert.ok(hit, '长单元复读应命中')
  assert.ok(hit.repeats >= 6 && hit.totalLength >= 400, '命中应达到阈值')
  assert.ok(hit.unitLength >= 4, '单元长度应 ≥ 4')

  // 短语级复读（单元 8 字符 × 200 次）→ 命中
  const hit2 = detectTailRepetition('好的好的好的好的'.repeat(50))
  assert.ok(hit2, '短语复读应命中')

  // 正常多样文本（各段内容互不相同）→ 不命中
  const sections = []
  for (let i = 1; i <= 30; i += 1) {
    sections.push(`## 第 ${i} 节\n\n- 要点甲：数据 ${i * 7}\n- 要点乙：结论 ${i * 13}\n\n\`\`\`js\nconsole.log("line-${i}")\n\`\`\`\n\n| 列A | 列B |\n|---|---|\n| ${i} | ${i * 2} |\n`)
  }
  assert.equal(detectTailRepetition(sections.join('\n')), null, '各段互不相同的多样文本不应命中')

  // 分隔线（单元 < 4 字符）→ 不命中
  assert.equal(detectTailRepetition(`章节一\n\n${'─'.repeat(300)}`), null, '单字符分隔线不应命中')

  // 短文本 → 不命中
  assert.equal(detectTailRepetition('好好好好好好好好好'), null, '短文本不应命中')

  ok('命中/不命中/阈值边界')
}

// ── 15. 飞书版 ask_user_question：setup 注册 + 按钮卡片 + 点击回答 ──
console.log('15) 飞书版 ask_user_question（卡片确认闭环）')
{
  const agents = makeAgentsRegistry()
  // 让 setup 拿到带 tools 的 agentCtx，捕获注册的 agent 级工具
  const registeredTools = new Map()
  const realCreate = agents.create
  agents.create = async (opts) => {
    if (opts.setup) {
      const original = opts.setup
      opts.setup = async (agentCtx) => {
        const ctxWithTools = {
          ...agentCtx,
          get: (name) => name === 'tools' ? { register: (def) => { registeredTools.set(def.name, def); return () => {} } } : undefined,
        }
        await original(ctxWithTools)
      }
    }
    return realCreate(opts)
  }
  const { send, handler, ctx } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  await handler({ chatId: 'oc_15', messageId: 'om_15', content: '你好', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  const askTool = registeredTools.get('ask_user_question')
  assert.ok(askTool, 'agent 级 ask_user_question 应已注册')
  // 触发问题：execute → 发送按钮卡片 + 提示文本，等待点击
  const promise = askTool.execute(
    { questions: [{ id: 'q1', question: '确认执行哪个方案？', options: ['方案A', '方案B'] }] },
    { agent: { id: agents.roots()[0].id }, signal: undefined },
  )
  await new Promise(r => setTimeout(r, 50))
  const cardSend = send.find(s => s.input?.card?.body?.elements?.some(e => e.tag === 'button'))
  assert.ok(cardSend, '应发送带按钮的交互卡片')
  const buttons = cardSend.input.card.body.elements.filter(e => e.tag === 'button')
  assert.equal(buttons.length, 2, '两个选项对应两个按钮（V2 平铺结构）')
  assert.ok(!cardSend.input.card.body.elements.some(e => e.tag === 'action'), '不得使用 action 容器（V2 不支持 200861）')
  const qid = buttons[0].value.feishu_q
  assert.ok(qid, '按钮 value 应携带 qid')
  assert.ok(send.some(s => typeof s.input?.text === 'string' && s.input.text.includes('编号')), '应有编号提示文本')
  // 模拟用户点击第二个按钮
  const cardAction = ctx.feishu.channel['handlers'].cardAction
  assert.ok(cardAction, '应订阅 cardAction 事件')
  await cardAction({ chatId: 'oc_15', messageId: 'om_c1', operator: { openId: 'ou_1' }, action: { tag: 'button', value: { feishu_q: qid, q: 'q1', o: '1' } } })
  const result = await promise
  assert.equal(result.answers[0].id, 'q1')
  assert.deepEqual(result.answers[0].selected, ['方案B'])
  ok('按钮点击 → 回答回流 → ask 完成')
}

// ── 16. 文字回复编号作为回答（不进入 agent 队列） ──────────────
console.log('16) 文字回复回答确认问题')
{
  const agents = makeAgentsRegistry()
  const registeredTools = new Map()
  const realCreate = agents.create
  agents.create = async (opts) => {
    if (opts.setup) {
      const original = opts.setup
      opts.setup = async (agentCtx) => {
        const ctxWithTools = {
          ...agentCtx,
          get: (name) => name === 'tools' ? { register: (def) => { registeredTools.set(def.name, def); return () => {} } } : undefined,
        }
        await original(ctxWithTools)
      }
    }
    return realCreate(opts)
  }
  const { send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  await handler({ chatId: 'oc_16', messageId: 'om_16', content: '你好', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  const askTool = registeredTools.get('ask_user_question')
  const agentId = agents.roots()[0].id
  const nBefore = agents.roots()[0].session.events.length
  const promise = askTool.execute(
    { questions: [{ id: 'q1', question: '选哪个？', options: ['甲', '乙', '丙'] }] },
    { agent: { id: agentId }, signal: undefined },
  )
  await new Promise(r => setTimeout(r, 50))
  // 用户回复编号 3
  await handler({ chatId: 'oc_16', messageId: 'om_17', content: '3', senderId: 'ou_1' })
  const result = await promise
  assert.deepEqual(result.answers[0].selected, ['丙'], '编号 3 应映射到「丙」')
  await new Promise(r => setTimeout(r, 30))
  const nAfter = agents.roots()[0].session.events.length
  assert.equal(nAfter, nBefore, '回答文本不应作为新消息进入 agent')
  ok('文字回复编号 → 直接回答，不污染 agent 会话')
}

// ── 17. 确认问题超时兜底：回合必然结束，队列不被堵死 ────────────
console.log('17) 确认问题超时兜底')
{
  const agents = makeAgentsRegistry()
  const registeredTools = new Map()
  const realCreate = agents.create
  agents.create = async (opts) => {
    if (opts.setup) {
      const original = opts.setup
      opts.setup = async (agentCtx) => {
        const ctxWithTools = {
          ...agentCtx,
          get: (name) => name === 'tools' ? { register: (def) => { registeredTools.set(def.name, def); return () => {} } } : undefined,
        }
        await original(ctxWithTools)
      }
    }
    return realCreate(opts)
  }
  const { handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false, questionTimeoutMs: 1200 },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  await handler({ chatId: 'oc_17', messageId: 'om_18', content: '你好', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  const askTool = registeredTools.get('ask_user_question')
  const promise = askTool.execute(
    { questions: [{ id: 'q1', question: '等谁？', options: ['A', 'B'] }] },
    { agent: { id: agents.roots()[0].id }, signal: undefined },
  )
  await assert.rejects(promise, (err) => err.code === 'ASK_TIMEOUT')
  ok('超时后 ask 以 ASK_TIMEOUT 结束（agent 回合可继续/收尾）')
}

// ── 18. 持久化映射 + resume 恢复会话（重启后上下文延续） ────────
console.log('18) 持久化映射 + resume 恢复')
{
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const storeDir = path.join(tmp, 'feishu-bot')
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(path.join(storeDir, 'chat-sessions.json'), JSON.stringify({ oc_resume: 'feishu-oc_resume-deadbeef' }))
    const resumeCalls = []
    // 带 resume 的 mock 注册表
    const live = new Map()
    const agents = {
      get: (id) => live.get(id),
      list: () => [...live.values()],
      roots: () => [...live.values()],
      create: async (opts) => {
        const a = makeAgent(opts.sessionId, opts.meta?.cwd, opts.agentOptions?.model)
        live.set(a.id, a)
        if (opts.setup) await opts.setup({ agent: a })
        return { agent: a, dispose: () => { live.delete(a.id); return Promise.resolve() } }
      },
      resume: async (opts) => {
        resumeCalls.push(opts.resumeSessionId)
        const a = makeAgent(opts.resumeSessionId, '/mnt/d/DSHProjects', opts.agentOptions?.model)
        live.set(a.id, a)
        if (opts.setup) await opts.setup({ agent: a })
        return { agent: a, dispose: () => { live.delete(a.id); return Promise.resolve() } }
      },
    }
    const { handler } = await boot(
      { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
      { agents, agentPresets: { defaultId: 'standard' } },
    )
    await handler({ chatId: 'oc_resume', messageId: 'om_19', content: '继续', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(resumeCalls.length, 1, '应尝试 resume 映射中的会话')
    assert.equal(resumeCalls[0], 'feishu-oc_resume-deadbeef')
    assert.equal(agents.roots().length, 1, '不应新建额外会话')
    assert.equal(agents.roots()[0].id, 'feishu-oc_resume-deadbeef', '恢复的是原会话')
    // /new 后映射应清除
    await handler({ chatId: 'oc_resume', messageId: 'om_20', content: '/new', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 30))
    const stored = JSON.parse(fs.readFileSync(path.join(storeDir, 'chat-sessions.json'), 'utf8'))
    assert.equal(stored.oc_resume, undefined, '/new 应清除持久化映射')
    ok('重启后 resume 恢复原会话；/new 清除映射')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 19. segmentChars 配置透传（原生流式分段阈值） ───────────────
console.log('19) segmentChars 配置透传')
{
  const agents = makeAgentsRegistry()
  const { ctx } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false, segmentChars: 5000 },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  const opts = ctx.feishu.channel.opts
  assert.ok(opts && opts.outbound, 'channel 应配置 outbound')
  assert.equal(opts.outbound.streamMaxElementChars, 5000, 'streamMaxElementChars 应等于 segmentChars')
  ok('segmentChars → SDK streamMaxElementChars 透传')
  const agents2 = makeAgentsRegistry()
  const { ctx: ctx2 } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents: agents2, agentPresets: { defaultId: 'standard' } },
  )
  assert.equal(ctx2.feishu.channel.opts.outbound.streamMaxElementChars, 8000, '默认 8000')
  ok('默认 segmentChars = 8000')
}

// ── 20. 旧链路分段：大内容拆成多张卡片，内容完整不丢失 ──────────
console.log('20) 旧链路分段发送')
{
  const agents = makeAgentsRegistry()
  // 让 agent 保持运行 ~1.3s，覆盖节流窗口 + 原生流式降级 + 收尾
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    h.agent.whenIdle = async () => { await new Promise(r => setTimeout(r, 1300)) }
    return h
  }
  const { listeners, send, handler, ctx } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false, segmentChars: 2000 },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  // 强制原生流式启动失败 → 走旧降级链路
  const channel = ctx.feishu.channel
  channel.stream = async () => { throw new Error('no cardkit (test)') }
  channel.send = async (to, input, opts) => { send.push({ to, input, opts }); return { messageId: `om_${send.length}` } }
  channel.updateCard = async (messageId, card) => { send.push({ to: 'EDIT-CARD', editMessageId: messageId, input: { card }, opts: undefined }) }
  channel.editMessage = async (messageId, text) => { send.push({ to: 'EDIT', editMessageId: messageId, input: { text }, opts: undefined }) }
  const h = channel['handlers'].message
  await h({ chatId: 'oc_20', messageId: 'om_20', content: '跑个长任务', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  // 模拟 agent 输出一个带代码块的长文件（约 300 行，跨多个分段阈值）
  const agent = agents.roots()[0]
  const longLines = []
  for (let i = 1; i <= 300; i += 1) longLines.push(`const line_${i} = ${i}; // 第 ${i} 行，凑长一些的内容让分段阈值生效`)
  const fileText = '```python\n' + longLines.join('\n') + '\n```'
  listeners['session/event']?.forEach(fn => fn({ id: agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: fileText } } }))
  await new Promise(r => setTimeout(r, 1500)) // 覆盖节流窗口 + 原生流式降级 + 收尾
  const cardSends = send.filter(s => s.input?.card && s.to !== 'EDIT-CARD')
  assert.ok(cardSends.length >= 3, `应发送至少 3 张分段卡片（实际 ${cardSends.length}）`)
  const joined = cardSends.map(s => {
    const els = s.input.card.body?.elements ?? []
    return els.filter(e => e.tag === 'markdown').map(e => e.content).join('\n')
  }).join('\n')
  for (const line of ['line_1', 'line_150', 'line_300']) {
    assert.ok(joined.includes(line), `分段后应包含完整内容（${line}）`)
  }
  // 逐行校验：300 行全部不丢失（分段漂移会丢行，这里必须全在）
  let missing = 0
  for (let i = 1; i <= 300; i += 1) {
    if (!joined.includes(`line_${i} =`)) missing += 1
  }
  assert.equal(missing, 0, `分段后应无丢失行（缺失 ${missing} 行）`)
  const first = cardSends[0].input.card.body.elements.find(e => e.tag === 'markdown').content
  assert.ok(first.length <= 2600, `首段应 ≤ 阈值+单行余量（实际 ${first.length}）`)
  ok(`长文件旧链路自动分段（${cardSends.length} 张卡片，300 行内容完整无丢失）`)
}

// ── 21. feishu_* 工具输出不含 undefined（lossless JSON 校验） ──
console.log('21) 工具输出无 undefined 字段')
{
  const regs = new Map()
  const fakeTools = { register: (t) => { regs.set(t.name, t); return () => {} } }
  const { ctx } = makeCtx({ tools: fakeTools })
  apply(ctx, Config['~standard'].validate({ appId: 'a', appSecret: 's', mode: 'echo', tools: true }).value)
  // 桩住 service：字段缺失/可选值为 undefined 的典型响应
  ctx.feishu.channel.send = async () => ({ messageId: 'om_1' })
  const svc = ctx.feishu
  svc.listChats = async () => [{ chatId: 'oc_x', name: undefined, description: undefined, chatMode: undefined, ownerId: undefined }]
  svc.listMessages = async () => [{
    messageId: 'om_y', msgType: undefined, content: undefined,
    senderId: undefined, senderName: undefined, createTime: undefined,
  }]
  svc.getChatInfo = async () => ({ chatId: 'oc_x', name: undefined, description: undefined, chatMode: 'group', memberCount: undefined, ownerId: undefined })
  const chats = await regs.get('feishu_list_chats').execute({}, {})
  const msgs = await regs.get('feishu_get_messages').execute({ chat_id: 'oc_x' }, {})
  const info = await regs.get('feishu_get_chat_info').execute({ chat_id: 'oc_x' }, {})
  for (const value of [chats, msgs, info]) {
    // 递归检查无 undefined：JSON.stringify 往返不失真
    const roundtrip = JSON.parse(JSON.stringify(value))
    assert.deepEqual(roundtrip, value, '序列化往返应无失真（不允许 undefined 字段）')
  }
  assert.deepEqual(msgs[0], { message_id: 'om_y' }, '缺失字段应整体省略而非置 undefined')
  ok('feishu_list_chats / feishu_get_messages / feishu_get_chat_info 输出无 undefined')
}

// ── 22. 原生流式钉头：超单卡上限时钉住头部，尾部切旧链路续传 ────
console.log('22) 原生流式钉头切链路')
{
  const agents = makeAgentsRegistry()
  // 让 agent 保持运行 ~1.3s，覆盖节流窗口 + 原生流式启动 + 钉头 + 收尾
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    h.agent.whenIdle = async () => { await new Promise(r => setTimeout(r, 1300)) }
    return h
  }
  const { listeners, send, handler, ctx } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false, segmentChars: 2000 },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  let streamCalls = 0
  const channel = ctx.feishu.channel
  const origStream = channel.stream
  channel.stream = async (to, input) => {
    streamCalls += 1
    return origStream(to, input)
  }
  const h = channel['handlers'].message
  await h({ chatId: 'oc_22', messageId: 'om_22', content: '长报告', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  // 模拟 agent 输出一个带代码块的长文件（约 300 行，远超单卡上限）
  const agent = agents.roots()[0]
  const longLines = []
  for (let i = 1; i <= 300; i += 1) longLines.push(`const line_${i} = ${i}; // 第 ${i} 行，凑长一些的内容让分段阈值生效`)
  const fileText = '```python\n' + longLines.join('\n') + '\n```'
  listeners['session/event']?.forEach(fn => fn({ id: agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: fileText } } }))
  await new Promise(r => setTimeout(r, 1500))
  // 区分：原生流式推送（无 schema 字段）与旧链路卡片（schema: '2.0'）
  const streamPushes = send.filter(s => s.input?.card && s.input.card.schema === undefined && s.input.card.body?.elements?.some(e => e.tag === 'markdown'))
  const cardSends = send.filter(s => s.input?.card && s.input.card.schema === '2.0')
  assert.equal(streamCalls, 1, '原生流式应只启动一次（钉头后不再重启）')
  assert.ok(streamPushes.length >= 1, '原生卡片应有内容推送')
  const head = streamPushes.map(s => s.input.card.body.elements.find(e => e.tag === 'markdown').content).join('\n')
  const over = streamPushes.filter(s => s.input.card.body.elements.find(e => e.tag === 'markdown').content.length > 2200)
  assert.equal(over.length, 0, `每次原生推送都应 ≤ 安全上限 + 单行余量（超限 ${over.length} 次，最长 ${Math.max(...streamPushes.map(s => s.input.card.body.elements.find(e => e.tag === 'markdown').content.length))}）`)
  assert.ok(cardSends.length >= 1, '钉头后应通过旧链路发送尾段卡片')
  const joined = [...streamPushes, ...cardSends].map(s => {
    const els = s.input.card.body?.elements ?? []
    return els.filter(e => e.tag === 'markdown').map(e => e.content).join('\n')
  }).join('\n')
  let missing = 0
  for (let i = 1; i <= 300; i += 1) {
    if (!joined.includes(`line_${i} =`)) missing += 1
  }
  assert.equal(missing, 0, `钉头切链路后内容应完整（缺失 ${missing} 行）`)
  ok(`原生流式钉头 + 旧链路续传（原生推送 ${streamPushes.length} 次，尾段卡片 ${cardSends.length} 张，300 行完整无丢失）`)
}

// ── 23. 超长单行：钉头 + 旧链路兜底，不冻结、内容不丢 ───────────
console.log('23) 超长单行不冻结')
{
  const agents = makeAgentsRegistry()
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    h.agent.whenIdle = async () => { await new Promise(r => setTimeout(r, 1300)) }
    return h
  }
  const { listeners, send, handler, ctx } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false, segmentChars: 2000 },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  let streamCalls = 0
  const channel = ctx.feishu.channel
  const origStream = channel.stream
  channel.stream = async (to, input) => {
    streamCalls += 1
    return origStream(to, input)
  }
  const h = channel['handlers'].message
  await h({ chatId: 'oc_23', messageId: 'om_23', content: '长单行', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 30))
  // 无换行的超长单行（6000 字符，内容无重复周期避免触发复读熔断）：
  // SDK rollover 切不开的典型场景（超长 URL / minified 代码 / 大段数据）。
  const agent = agents.roots()[0]
  let x = 12345
  let single = ''
  for (let i = 0; i < 6000; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    single += String(x % 10)
  }
  listeners['session/event']?.forEach(fn => fn({ id: agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: single } } }))
  await new Promise(r => setTimeout(r, 1500))
  const streamPushes = send.filter(s => s.input?.card && s.input.card.schema === undefined && s.input.card.body?.elements?.some(e => e.tag === 'markdown'))
  const cardSends = send.filter(s => s.input?.card && s.input.card.schema === '2.0')
  const textSends = send.filter(s => typeof s.input?.text === 'string')
  assert.equal(streamCalls, 1, '原生流式应只启动一次')
  assert.ok(streamPushes.length >= 1, '原生卡片应有头部推送')
  const joined = [
    ...streamPushes.map(s => s.input.card.body.elements.find(e => e.tag === 'markdown').content),
    ...cardSends.map(s => s.input.card.body.elements.find(e => e.tag === 'markdown').content),
    ...textSends.map(s => s.input.text),
  ].join('')
  assert.ok(joined.includes(single), '超长单行全文应完整送达（钉头 + 尾部兜底）')
  assert.ok(joined.length >= 6000, `送达内容总长应 ≥ 6000（实际 ${joined.length}）`)
  ok(`超长单行不冻结（原生 ${streamPushes.length} 次推送 + 尾卡 ${cardSends.length} 张 + 文本 ${textSends.length} 条，全文完整）`)
}

// ── 24. 激活被归档会话时自动取消归档（恢复工作区显示） ──────────
console.log('24) 激活归档会话自动取消归档')
{
  // 24a: /attach 接手归档会话 → registry.setState 移除该会话
  const archivedAgent = makeAgent('feishu-test-archived', '/mnt/d/DSHProjects')
  const agents = makeAgentsRegistry([archivedAgent])
  const setStateCalls = []
  const fakeRegistry = {
    archivedSessionIds: ['feishu-test-archived', 'other-archived'],
    requireState: () => ({ archivedSessionIds: ['feishu-test-archived', 'other-archived'] }),
    setState: async (state) => { setStateCalls.push([...state.archivedSessionIds]) },
  }
  const { handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' }, workspaceRegistry: fakeRegistry },
  )
  await handler({ chatId: 'oc_24', messageId: 'om_24', content: '/attach feishu-test-archived', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(setStateCalls.length, 1, '/attach 归档会话应触发取消归档')
  assert.ok(!setStateCalls[0].includes('feishu-test-archived'), '被激活的会话应移出归档')
  assert.ok(setStateCalls[0].includes('other-archived'), '其他归档会话应保留')
  ok('/attach 接手归档会话自动取消归档')

  // 24b: 消息驱动自动创建（非 attach）→ 同样取消归档
  const agents2 = makeAgentsRegistry()
  const realCreate = agents2.create
  agents2.create = async (opts) => realCreate({ ...opts, sessionId: 'feishu-oc_24b-autoarchive' }) // 固定 id 便于断言
  const setStateCalls2 = []
  const fakeRegistry2 = {
    archivedSessionIds: ['feishu-oc_24b-autoarchive', 'other-archived'],
    requireState: () => ({ archivedSessionIds: ['feishu-oc_24b-autoarchive', 'other-archived'] }),
    setState: async (state) => { setStateCalls2.push([...state.archivedSessionIds]) },
  }
  const { handler: handler2 } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents: agents2, agentPresets: { defaultId: 'standard' }, workspaceRegistry: fakeRegistry2 },
  )
  const h2 = handler2
  await h2({ chatId: 'oc_24b', messageId: 'om_24b', content: '你好', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(setStateCalls2.length, 1, '消息激活新建会话应触发取消归档')
  assert.ok(!setStateCalls2[0].includes('feishu-oc_24b-autoarchive'), '新建激活的会话应移出归档')
  assert.ok(setStateCalls2[0].includes('other-archived'), '其他归档会话应保留')
  ok('消息驱动（自动创建路径）同样自动取消归档')
}

// ── 25. /new 无活跃会话时清除持久化映射（下次消息真正新建） ─────
console.log('25) /new 无活跃会话清除映射')
{
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const storeDir = path.join(tmp, 'feishu-bot')
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(path.join(storeDir, 'chat-sessions.json'), JSON.stringify({ oc_new: 'feishu-oc_new-oldmapping' }))
    const agents = makeAgentsRegistry() // 无活跃会话
    const { handler } = await boot(
      { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
      { agents, agentPresets: { defaultId: 'standard' } },
    )
    await handler({ chatId: 'oc_new', messageId: 'om_new', content: '/new', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 50))
    const stored = JSON.parse(fs.readFileSync(path.join(storeDir, 'chat-sessions.json'), 'utf8'))
    assert.equal(stored.oc_new, undefined, '无活跃会话时 /new 也应清除持久化映射')
    ok('无活跃会话时 /new 清除持久化映射（下条消息真正新建会话）')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 26. 问题卡片 V2 结构回归：无 action 容器、按钮平铺、无 update_multi ──
console.log('26) 问题卡片 V2 结构')
{
  const { buildQuestionCard } = await import('../lib/questions.js')
  const card = buildQuestionCard({
    qid: 'qid-test-1',
    chatId: 'oc_x',
    questions: [{ id: 'q1', header: '选择', question: '选哪个？', options: ['方案甲', '方案乙'], multiSelect: false }],
  })
  assert.equal(card.schema, '2.0', '应为 schema 2.0')
  const elements = card.body.elements
  assert.ok(!elements.some(e => e.tag === 'action'), '不允许 action 容器（V2 不支持，200861）')
  assert.ok(!JSON.stringify(card).includes('update_multi'), '不应携带 update_multi 配置（300302）')
  const buttons = elements.filter(e => e.tag === 'button')
  assert.equal(buttons.length, 2, '选项数 = 按钮数')
  assert.equal(buttons[0].type, 'primary', '首个选项按钮 primary')
  assert.equal(buttons[1].type, 'default', '其余按钮 default')
  assert.deepEqual(buttons[0].value, { feishu_q: 'qid-test-1', q: 'q1', o: '0' }, '按钮 value 编码 qid/question/option')
  assert.deepEqual(buttons[1].value, { feishu_q: 'qid-test-1', q: 'q1', o: '1' }, '第二个按钮 option=1')
  const tags = elements.map(e => e.tag)
  assert.deepEqual(tags, ['markdown', 'markdown', 'button', 'button'], '结构：问题 md + 选项列表 md + 平铺按钮')
  ok('问题卡片为 V2 合法结构（按钮平铺、无 action 容器、无 update_multi、value 正确）')
}

// ── 27. 占位卡片（v0.6.7）：回合开始即上屏，首批文本后续写同一张卡 ──
console.log('27) 占位卡片：工具执行期即时反馈')
{
  const agents = makeAgentsRegistry()
  let releaseIdle
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    h.agent.whenIdle = () => new Promise(r => { releaseIdle = r })
    return h
  }
  const { listeners, send, handler, ctx } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  let streamCalls = 0
  const channel = ctx.feishu.channel
  const origStream = channel.stream
  channel.stream = async (to, input) => { streamCalls += 1; return origStream(to, input) }

  const pending = handler({ chatId: 'oc_27', messageId: 'om_27', content: '慢慢查', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 80))
  // 工具执行期（尚无任何文本）：占位卡已启动，且没有多余消息/卡片发出
  assert.equal(streamCalls, 1, '回合开始应立即启动 1 次原生流式（占位卡）')
  assert.equal(send.length, 0, '工具期不应额外发送内容消息（占位卡由 SDK 承载）')

  // 首批文本到达：续写同一张卡（不新增流式）
  const agent = agents.roots()[0]
  listeners['session/event']?.forEach(fn => fn({ id: agent.id }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '分析完成，结论如下。' } } }))
  await new Promise(r => setTimeout(r, 600))
  assert.equal(streamCalls, 1, '首批文本应续写同一张占位卡（不新增流式）')
  assert.ok(send.map(s => textOf(s.input)).join('').includes('分析完成，结论如下。'), '占位卡上应已有正文')

  releaseIdle()
  await pending
  await new Promise(r => setTimeout(r, 50))
  assert.equal(streamCalls, 1, '整回合只应有一次原生流式')
  assert.ok(textOf(send[send.length - 1].input).includes('分析完成，结论如下。'), '收尾内容完整')
  ok('占位卡片：回合开始即上屏，首批文本无缝续写（整回合 1 次流式）')
}

// ── 28. 空回合：占位卡以中性提示收尾，不出现 '(no content)' ──────
console.log('28) 空回合中性收尾')
{
  const agents = makeAgentsRegistry()
  let releaseIdle
  const realCreate = agents.create
  agents.create = async (opts) => {
    const h = await realCreate(opts)
    h.agent.whenIdle = () => new Promise(r => { releaseIdle = r })
    return h
  }
  const { send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, persistSessions: false },
    { agents, agentPresets: { defaultId: 'standard' } },
  )
  const pending = handler({ chatId: 'oc_28', messageId: 'om_28', content: '只跑工具不说话', senderId: 'ou_1' })
  await new Promise(r => setTimeout(r, 80))
  releaseIdle()
  await pending
  await new Promise(r => setTimeout(r, 50))
  const joined = send.map(s => textOf(s.input)).join('\n')
  assert.ok(joined.includes('（本轮没有文本输出）'), '空回合应以中性提示收尾')
  assert.ok(!joined.includes('(no content)'), '不应出现 SDK 默认英文占位')
  ok('空回合：占位卡中性提示收尾')
}

// ── 29. 会话去向透明化（v0.6.8）：/detach、/sessions 如实说明 resume 目标 ──
console.log('29) /detach 与 /sessions 的映射去向提示')
{
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const storeDir = path.join(tmp, 'feishu-bot')
    fs.mkdirSync(storeDir, { recursive: true })
    const MAPPED = 'feishu-oc_map-daytime-abcdef12'
    fs.writeFileSync(path.join(storeDir, 'chat-sessions.json'), JSON.stringify({ oc_map: MAPPED }))
    const guiAgent = makeAgent('session-gui-1', '/mnt/d/DSHProjects')
    const agents = makeAgentsRegistry([guiAgent])
    const { send, handler } = await boot(
      { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
      { agents, agentPresets: { defaultId: 'standard' } },
    )
    // 1) /attach 到与映射不同的会话：应提示映射仍指向旧会话
    await handler({ chatId: 'oc_map', messageId: 'om_1', content: '/attach session-gui-1', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 30))
    const attachNote = send.map(s => textOf(s.input)).find(t => t.includes('持久映射仍指向'))
    assert.ok(attachNote, '/attach 差异目标时应有映射提醒')
    assert.ok(attachNote.includes('feishu-oc_ma…abcdef12'), `映射提醒应含缩写 id（实际：${attachNote}）`)
    // 2) /detach：应说明下一条消息将恢复映射会话，并给出 /new 指引
    send.length = 0
    await handler({ chatId: 'oc_map', messageId: 'om_2', content: '/detach', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 30))
    const detachReply = textOf(send[send.length - 1].input)
    assert.ok(detachReply.includes('已解除接手'), '/detach 应回复解除成功')
    assert.ok(detachReply.includes('将自动恢复会话') && detachReply.includes('/new'), `/detach 应说明去向与 /new 指引（实际：${detachReply}）`)
    // 3) /sessions：未接手时应显示映射去向行
    send.length = 0
    await handler({ chatId: 'oc_map', messageId: 'om_3', content: '/sessions', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 30))
    const sessionsReply = textOf(send[send.length - 1].input)
    assert.ok(sessionsReply.includes('未接手 · 下一条消息将自动恢复'), `/sessions 应显示映射去向（实际：${sessionsReply.slice(0, 200)}）`)
    // 4) 无活跃会话但映射仍在（重启后场景）：/sessions 应给出恢复提示
    const { send: send2, handler: handler2 } = await boot(
      { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
      { agents: makeAgentsRegistry(), agentPresets: { defaultId: 'standard' } },
    )
    await handler2({ chatId: 'oc_map', messageId: 'om_4', content: '/sessions', senderId: 'ou_1' })
    await new Promise(r => setTimeout(r, 30))
    const emptyReply = textOf(send2[send2.length - 1].input)
    assert.ok(emptyReply.includes('持久映射仍指向') && emptyReply.includes('自动恢复'), `空列表时应提示恢复目标（实际：${emptyReply.slice(0, 200)}）`)
    ok('/detach、/attach、/sessions 均如实说明下一条消息的去向（恢复映射会话/新建）')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\n全部通过（${passed} 项断言组）✅`)

