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
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
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
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
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
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
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
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
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
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
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
  ok('流式输出：首段发送 + 后续编辑更新')
}

// ── 11. 任务执行中回应（running → steer + 流式收尾） ──────────
console.log('11) 任务执行中回应')
{
  const agents = makeAgentsRegistry()
  const { listeners, send, handler } = await boot(
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false },
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
    { appId: 'cli_x', appSecret: 's', mode: 'agent', workspace: '/mnt/d/DSHProjects', tools: false, attachHistory: 3 },
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

console.log(`\n全部通过（${passed} 项断言组）✅`)

