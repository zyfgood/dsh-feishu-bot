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

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import type { CardActionEvent } from '@larksuiteoapi/node-sdk'
import type { FeishuService } from './service.ts'

/** 单个待确认问题（与全局 ask_user_question 的 question 结构一致）。 */
export interface AskQuestion {
  id: string
  question: string
  header?: string
  options?: string[]
  multiSelect?: boolean
}

/** ask_user_question 工具的输出载荷（与全局工具一致，供模型消费）。 */
export interface AskAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 一个进行中的确认请求。 */
export interface PendingQuestion {
  /** 唯一请求 id，同时编码进按钮 value 与文本回执。 */
  qid: string
  chatId: string
  /** 发起 agent（ask 覆盖路径）；feishu_ask_choice 可能来自任意 agent。 */
  agentId?: string
  questions: AskQuestion[]
  /** question id → 已选标签（按钮点击累积，文本回复覆盖）。 */
  answers: Map<string, string[]>
  resolve: (value: { answers: AskAnswerItem[] }) => void
  reject: (error: Error) => void
  /** 超时定时器（未答则 reject ASK_TIMEOUT）。 */
  timer: ReturnType<typeof setTimeout>
  /** 已完结（resolve/reject 只触发一次）。 */
  finished: boolean
  /** 提示文本已发送（避免重复）。 */
  hinted: boolean
  /** 调用方中止信号（cleanup 时移除监听）。 */
  signal?: AbortSignal
  /** 中止监听器引用（cleanup 时移除）。 */
  onAbort?: () => void
}

/** 待确认状态：按 chatId 维护栈（同会话并发询问取最新未答），按 qid 索引。 */
export class PendingQuestionState {
  private readonly byChat = new Map<string, PendingQuestion[]>()
  private readonly byQid = new Map<string, PendingQuestion>()

  constructor(
    private readonly ctx: Context,
    private readonly service: FeishuService,
    private readonly timeoutMs: number,
  ) {
    // 订阅卡片按钮点击：value 里带 feishu_q=qid，命中即回答。
    service.channel.on({
      cardAction: (evt: CardActionEvent) => {
        this.onCardAction(evt).catch((error: unknown) => {
          ctx.logger.warn('feishu: 处理卡片点击异常', error)
        })
      },
    })
  }

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
  askViaChat(
    chatId: string,
    agentId: string | undefined,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
    timeoutMs = this.timeoutMs,
  ): Promise<{ answers: AskAnswerItem[] }> {
    if (questions.length === 0) {
      return Promise.reject(Object.assign(new Error('ask_user_question requires at least one question'), { code: 'EMPTY_QUESTIONS' }))
    }
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('ask_user_question was aborted before the user answered'), { code: 'ASK_ABORTED' }))
    }
    return new Promise((resolve, reject) => {
      const pending: PendingQuestion = {
        qid: randomUUID(),
        chatId,
        agentId,
        questions,
        answers: new Map(),
        resolve: (value) => {
          if (pending.finished) return
          pending.finished = true
          this.cleanup(pending)
          resolve(value)
        },
        reject: (error) => {
          if (pending.finished) return
          pending.finished = true
          this.cleanup(pending)
          reject(error)
        },
        timer: setTimeout(() => {
          this.finishTimeout(pending)
        }, Math.max(timeoutMs, 1000)),
        finished: false,
        hinted: false,
      }
      const onAbort = (): void => {
        pending.reject(Object.assign(new Error('ask_user_question was aborted before the user answered'), { code: 'ASK_ABORTED' }))
      }
      if (signal !== undefined) {
        pending.signal = signal
        pending.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.push(pending)
      // 发送提示卡片与文本（发送失败不阻断等待，卡片失败时文本兜底）。
      void this.present(pending).catch((error: unknown) => {
        this.ctx.logger.warn('feishu: 发送确认卡片失败（用户仍可回复编号）', error)
      })
    })
  }

  /** 该会话是否存在未完结的待确认问题。 */
  hasPending(chatId: string): boolean {
    const stack = this.byChat.get(chatId)
    return stack !== undefined && stack.some(p => !p.finished)
  }

  /**
   * 取消该会话当前所有待确认问题（agent 会收到 ASK_CANCELLED 错误结果，
   * 自行决定继续或收尾）。返回是否确有挂起问题被取消。
   */
  cancelFor(chatId: string): boolean {
    const stack = this.byChat.get(chatId)
    if (!stack || stack.length === 0) return false
    let cancelled = false
    for (const pending of [...stack]) {
      if (pending.finished) continue
      cancelled = true
      pending.reject(Object.assign(
        new Error('the user cancelled the question'),
        { code: 'ASK_CANCELLED' },
      ))
    }
    return cancelled
  }

  /** 发送确认交互卡片 + 编号提示文本（cardAction 主通道 + 文本兜底）。 */
  private async present(pending: PendingQuestion): Promise<void> {
    try {
      await this.service.sendCard(pending.chatId, buildQuestionCard(pending))
    } catch (error) {
      // 卡片发送失败（权限/格式/内容限制等）：不阻断确认流程——
      // 提示文本含完整选项清单，用户回复编号/选项文字即可回答。
      // （2026-09-02 事故：卡片因 update_multi:false 被飞书拒绝后，
      //   present 直接抛错导致提示文本也未发送，任务静默停滞。）
      this.ctx.logger.warn('feishu: 确认卡片发送失败，改用文本提示（可回复编号回答）', error)
    }
    if (!pending.hinted) {
      pending.hinted = true
      await this.service.send(pending.chatId, { text: buildQuestionHint(pending) })
    }
  }

  /**
   * 尝试把一条入站文本当作问题回答消费掉。命中返回 true（消息已处理，
   * 不应再走命令/agent 路由）；未命中返回 false。
   */
  consumeTextAnswer(chatId: string, text: string): boolean {
    const stack = this.byChat.get(chatId)
    if (!stack || stack.length === 0) return false
    // 取最新的未完结问题（后发先答）。
    const pending = [...stack].reverse().find(p => !p.finished)
    if (!pending) return false
    const parsed = parseAnswerText(pending, text)
    if (parsed === null) return false
    for (const [qid, labels] of parsed) pending.answers.set(qid, labels)
    if (allAnswered(pending)) {
      pending.resolve({ answers: toAnswerItems(pending) })
    } else {
      void this.service.sendText(chatId, '✅ 已记录，请继续回答剩余问题（或直接回复编号）。')
    }
    return true
  }

  /** 处理卡片按钮点击。 */
  private async onCardAction(evt: CardActionEvent): Promise<void> {
    const value = evt.action?.value
    if (typeof value !== 'object' || value === null) return
    const qid = (value as Record<string, unknown>).feishu_q
    if (typeof qid !== 'string') return
    const pending = this.byQid.get(qid)
    if (!pending || pending.finished || pending.chatId !== evt.chatId) return
    const questionId = (value as Record<string, unknown>).q
    const optionIndex = Number((value as Record<string, unknown>).o)
    const question = pending.questions.find(q => q.id === questionId)
    if (!question || !question.options || !Number.isInteger(optionIndex)) return
    const label = question.options[optionIndex]
    if (label === undefined) return
    const selected = pending.answers.get(question.id) ?? []
    if (question.multiSelect && !selected.includes(label)) {
      pending.answers.set(question.id, [...selected, label])
    } else {
      pending.answers.set(question.id, [label])
    }
    if (allAnswered(pending)) {
      pending.resolve({ answers: toAnswerItems(pending) })
    } else {
      void this.service.sendText(pending.chatId, `✅ 已选择：${label}`)
    }
  }

  /** 超时兜底：回合必须能结束（agent 会收到错误结果并继续/收尾）。 */
  private finishTimeout(pending: PendingQuestion): void {
    if (pending.finished) return
    void this.service.sendText(
      pending.chatId,
      `⏰ 确认等待超时（${Math.round(this.timeoutMs / 60000)} 分钟未收到回答），该次询问已取消。如需继续请直接发消息。`,
    ).catch(() => {})
    pending.reject(Object.assign(new Error('等待用户确认超时'), { code: 'ASK_TIMEOUT' }))
  }

  private push(pending: PendingQuestion): void {
    const stack = this.byChat.get(pending.chatId) ?? []
    stack.push(pending)
    this.byChat.set(pending.chatId, stack)
    this.byQid.set(pending.qid, pending)
  }

  private cleanup(pending: PendingQuestion): void {
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    const stack = this.byChat.get(pending.chatId)
    if (stack) {
      const i = stack.indexOf(pending)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0) this.byChat.delete(pending.chatId)
    }
    this.byQid.delete(pending.qid)
  }
}

/** 全部问题都已回答。 */
function allAnswered(pending: PendingQuestion): boolean {
  return pending.questions.every(q => (pending.answers.get(q.id)?.length ?? 0) > 0)
}

/** 组装与全局 ask_user_question 一致的输出载荷。 */
function toAnswerItems(pending: PendingQuestion): AskAnswerItem[] {
  return pending.questions.map(q => ({
    id: q.id,
    selected: pending.answers.get(q.id) ?? [],
  }))
}

/**
 * 把文本回复解析为「问题 id → 选项标签」：
 * - 纯编号（如 `1`、`2,3`、`1 3`）：第 k 个数字回答第 k 个问题（1 基）；
 * - 与某个未回答问题的选项标签完全一致：回答该问题。
 * 其余文本（含 / 开头命令）返回 null，按普通消息处理。
 */
export function parseAnswerText(
  pending: PendingQuestion,
  text: string,
): Map<string, string[]> | null {
  const t = text.trim()
  if (!t || t.startsWith('/')) return null
  if (/^[\d\s,，、]+$/.test(t)) {
    const nums = t.split(/[\s,，、]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1)
    if (nums.length === 0) return null
    const answers = new Map<string, string[]>()
    if (pending.questions.length === 1) {
      // 单个问题：所有编号都属于它（多选时合并）。
      const q = pending.questions[0]
      if (!q.options) return null
      const labels = nums
        .map(n => q.options?.[n - 1])
        .filter((label): label is string => label !== undefined)
      if (labels.length === 0) return null
      answers.set(q.id, q.multiSelect ? [...new Set(labels)] : [labels[labels.length - 1]])
    } else {
      // 多个问题：第 k 个数字回答第 k 个问题（1 基）。
      for (let i = 0; i < pending.questions.length; i += 1) {
        const q = pending.questions[i]
        const n = nums[i]
        if (n === undefined || !q.options || !q.options[n - 1]) continue
        answers.set(q.id, [q.options[n - 1]])
      }
    }
    return answers.size > 0 ? answers : null
  }
  for (const q of pending.questions) {
    if ((pending.answers.get(q.id)?.length ?? 0) > 0) continue
    if (q.options?.some(o => o === t)) return new Map([[q.id, [t]]])
  }
  return null
}

/** 确认交互卡片（schema 2.0，按钮 value 编码 qid/question/option）。 */
export function buildQuestionCard(pending: PendingQuestion): object {
  const elements: object[] = []
  for (const [index, q] of pending.questions.entries()) {
    elements.push({
      tag: 'markdown',
      content: `${q.header ? `**${q.header}**\n` : ''}${q.question}`,
    })
    if (q.options && q.options.length > 0) {
      // 编号列表（无按钮客户端也能照着回复编号）。
      elements.push({
        tag: 'markdown',
        content: q.options.map((label, i) => `${i + 1}. ${label}`).join('\n'),
      })
      // 按钮必须是 body.elements 的直接子元素：不能再包在 tag:'action'
      // 容器里——卡片 JSON V2 不支持 action 容器（230099/200861
      // 「cards of schema V2 no longer support this capability;
      //  unsupported tag action」，2026-09-02 实测）。按钮文本用编号，
      // 与上方列表对应；点击经 cardAction 事件回流 onCardAction。
      for (const [i] of q.options.entries()) {
        elements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: String(i + 1) },
          type: i === 0 && index === 0 ? 'primary' : 'default',
          value: { feishu_q: pending.qid, q: q.id, o: String(i) },
        })
      }
    }
  }
  return {
    schema: '2.0',
    // 注意：不能写 update_multi: false —— 飞书对交互卡片消息的创建会拒绝
    // 显式 update_multi=false 的卡片（230099 / 300302「update_multi is
    // false」，实测 2026-09-02）。静态确认卡片不需要独享模式，缺省即可。
    body: { elements },
  }
}

/** 确认提示文本（卡片之外补一条，明确告知可回复编号；卡片发送失败时文本兜底可答）。 */
export function buildQuestionHint(pending: PendingQuestion): string {
  const summary = pending.questions.map(q => q.question).join('；')
  const lines: string[] = []
  for (const [qi, q] of pending.questions.entries()) {
    lines.push(`${qi + 1}. ${q.header ? `【${q.header}】` : ''}${q.question}`)
    if (q.options && q.options.length > 0) {
      q.options.forEach((label, i) => lines.push(`    ${i + 1}. ${label}`))
    }
  }
  const first = pending.questions[0]
  const how = first?.options?.length
    ? '请点击上方卡片按钮，或直接回复选项编号（如「1」）或选项文字'
    : '请直接回复你的回答'
  return `🤔 需要你确认：${summary}\n${lines.join('\n')}\n${how}。`
}

/**
 * 为自动创建的飞书 agent 注册「飞书版 ask_user_question」。
 * 挂到 agent 的 ctx（agent 级 shadowing，覆盖全局 GUI 版）：
 * 问题以交互卡片发到飞书，回答通过按钮/文本回流，超时兜底。
 */
export function defineFeishuAskTool(
  state: PendingQuestionState,
  chatIdFor: (agentId: string | undefined) => string | undefined,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'ask_user_question',
    description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
      + 'Send one or more questions, each with a stable id that will be echoed in the answer. '
      + '（飞书版：问题以交互卡片发送到当前飞书会话，用户点击按钮或回复编号回答）',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: { type: 'string', description: 'Optional short heading for the question.' },
            options: {
              type: 'array',
              description: 'Optional choices; rendered as clickable buttons in Feishu. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: { type: 'string' },
            },
            multi_select: { type: 'boolean', description: 'Whether the user may select more than one option. Defaults to false.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const chatId = chatIdFor(exec.agent?.id)
      if (chatId === undefined) {
        return Promise.reject(Object.assign(
          new Error('当前 agent 不属于飞书会话，无法在飞书侧提问（请在 Web 界面使用）'),
          { code: 'NOT_FEISHU_AGENT' },
        ))
      }
      return state.askViaChat(chatId, exec.agent?.id, args.questions, exec.signal)
    },
  })
}
