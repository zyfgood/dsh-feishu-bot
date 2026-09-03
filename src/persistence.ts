/**
 * 飞书会话绑定持久化：chat_id → DSH session_id 映射落盘。
 *
 * 背景（2026-08-31 事故）：会话绑定只存在内存，dsh web 每次重启后同一
 * 飞书群会被当成新用户，插件新建 agent 会话导致上下文清零（同一天同一群
 * 产生 4+ 个 feishu-* 会话）。映射落盘后，重启/插件重载后消息会先尝试
 * `agents.resume()` 恢复原会话，对话上下文得以延续。
 *
 * @module dsh-feishu-bot/persistence
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

/** 映射文件默认位置：$DSH_HOME/feishu-bot/chat-sessions.json（DSH_HOME 缺省 ~/.dsh）。 */
export function defaultStorePath(): string {
  const home = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  return join(home, 'feishu-bot', 'chat-sessions.json')
}

/** chat_id → session_id 的持久化映射（文件读写，原子替换）。 */
export class ChatSessionStore {
  private data = new Map<string, string>()

  private constructor(
    private readonly path: string,
    initial: Record<string, string>,
  ) {
    for (const [chatId, sessionId] of Object.entries(initial)) {
      this.data.set(chatId, sessionId)
    }
  }

  /** 加载（文件不存在/损坏则视为空映射）。 */
  static load(path = defaultStorePath()): ChatSessionStore {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
        return new ChatSessionStore(path, raw)
      }
    } catch (error) {
      // 损坏时忽略并重建（不阻断插件运行）。
      void error
    }
    return new ChatSessionStore(path, {})
  }

  get(chatId: string): string | undefined {
    return this.data.get(chatId)
  }

  set(chatId: string, sessionId: string): void {
    this.data.set(chatId, sessionId)
    this.save()
  }

  delete(chatId: string): void {
    if (this.data.delete(chatId)) this.save()
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      // 持久化失败不影响功能（下次消息会新建会话），只记日志。
      void error
    }
  }
}

/** /model 命令设置的模型选择（chat_id 维度，跨重启保留）。 */
export interface StoredModelSelection {
  provider: string
  model: string
}

/** chat_id → 模型选择 的持久化映射（/model 命令写入，原子替换落盘）。 */
export class ModelOverrideStore {
  private data = new Map<string, StoredModelSelection>()

  private constructor(
    private readonly path: string,
    initial: Record<string, StoredModelSelection>,
  ) {
    for (const [chatId, selection] of Object.entries(initial)) {
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        this.data.set(chatId, { provider: selection.provider, model: selection.model })
      }
    }
  }

  /** 模型覆盖文件默认位置：$DSH_HOME/feishu-bot/model-overrides.json。 */
  static defaultPath(): string {
    const home = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
    return join(home, 'feishu-bot', 'model-overrides.json')
  }

  /** 加载（文件不存在/损坏则视为空映射）。 */
  static load(path = ModelOverrideStore.defaultPath()): ModelOverrideStore {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, StoredModelSelection>
        return new ModelOverrideStore(path, raw)
      }
    } catch (error) {
      // 损坏时忽略并重建（不阻断插件运行）。
      void error
    }
    return new ModelOverrideStore(path, {})
  }

  get(chatId: string): StoredModelSelection | undefined {
    return this.data.get(chatId)
  }

  set(chatId: string, selection: StoredModelSelection): void {
    this.data.set(chatId, { ...selection })
    this.save()
  }

  delete(chatId: string): boolean {
    const removed = this.data.delete(chatId)
    if (removed) this.save()
    return removed
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      // 落盘失败不影响本进程内的切换（重启后回到默认），只记日志。
      void error
    }
  }
}
