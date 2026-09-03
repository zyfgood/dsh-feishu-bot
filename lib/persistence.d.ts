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
/** 映射文件默认位置：$DSH_HOME/feishu-bot/chat-sessions.json（DSH_HOME 缺省 ~/.dsh）。 */
export declare function defaultStorePath(): string;
/** chat_id → session_id 的持久化映射（文件读写，原子替换）。 */
export declare class ChatSessionStore {
    private readonly path;
    private data;
    private constructor();
    /** 加载（文件不存在/损坏则视为空映射）。 */
    static load(path?: string): ChatSessionStore;
    get(chatId: string): string | undefined;
    set(chatId: string, sessionId: string): void;
    delete(chatId: string): void;
    private save;
}
/** /model 命令设置的模型选择（chat_id 维度，跨重启保留）。 */
export interface StoredModelSelection {
    provider: string;
    model: string;
}
/** chat_id → 模型选择 的持久化映射（/model 命令写入，原子替换落盘）。 */
export declare class ModelOverrideStore {
    private readonly path;
    private data;
    private constructor();
    /** 模型覆盖文件默认位置：$DSH_HOME/feishu-bot/model-overrides.json。 */
    static defaultPath(): string;
    /** 加载（文件不存在/损坏则视为空映射）。 */
    static load(path?: string): ModelOverrideStore;
    get(chatId: string): StoredModelSelection | undefined;
    set(chatId: string, selection: StoredModelSelection): void;
    delete(chatId: string): boolean;
    private save;
}
//# sourceMappingURL=persistence.d.ts.map