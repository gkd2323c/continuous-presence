/**
 * continuous-presence/lib/node-resolver.js
 *
 * node_id 精准回溯机制。
 *
 * 每条消息在会话文件中都有一个唯一 ID。本模块提供：
 * - node_id 格式: `{sessionId}:{messageId}`（如 `019e00cc...:504c4d9f`）
 * - 双向解析：node_id → 原文，message_id → 上下文
 * - 会话文件扫描：按 session_id 精确匹配文件，避免全量扫描
 *
 * 设计原则：
 * - 确定性：给定 node_id，始终能找到原文
 * - 轻量：用 session_id 精确定位文件，不扫描无关文件
 * - 渐进披露：上下文先取摘要，需要时再 resolve 原文
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// ── node_id 格式 ──

/**
 * 从消息事件提取 node_id
 * @param {string} sessionId - 会话 ID（来自 session event 的 id 字段或文件名）
 * @param {object} msgEvent - message 类型的事件对象
 * @returns {string} node_id
 */
export function makeNodeId(sessionId, msgEvent) {
  const msgId = msgEvent?.id || "unknown";
  return `${sessionId}:${msgId}`;
}

/**
 * 从文件名中提取 session_id
 * 文件名格式: `2026-05-07T04-57-28-199Z_019e00cc-4786-726d-a126-d67721cfc818.jsonl`
 * session_id 是第二个 `_` 之后的部分（去掉 .jsonl）
 * 或者直接用 id 字段
 */
export function extractSessionIdFromFilename(filename) {
  const base = path.basename(filename, ".jsonl");
  // 文件名格式: timestamp_uuid 或 archived\timestamp_uuid
  const parts = base.split("_");
  // session UUID 通常是最后一个下划线后面的部分
  if (parts.length >= 2) {
    // 取最后一个看起来像 UUID 的部分
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) {
        return part;
      }
    }
    // fallback: 取第二部分
    return parts.slice(1).join("_");
  }
  return base;
}

/**
 * 从 node_id 中解析 sessionId 和 messageId
 * @param {string} nodeId - "sessionId:messageId" 格式
 * @returns {{ sessionId: string, messageId: string } | null}
 */
export function parseNodeId(nodeId) {
  if (!nodeId || typeof nodeId !== "string") return null;
  const colonIdx = nodeId.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    sessionId: nodeId.slice(0, colonIdx),
    messageId: nodeId.slice(colonIdx + 1),
  };
}

// ── 解析器 ──

/**
 * 创建 node_id 解析器
 * @param {object} opts
 * @param {string} opts.sessionsDir - 会话文件目录
 * @param {object} opts.log - logger
 * @returns {NodeResolver}
 */
export function createNodeResolver({ sessionsDir, log }) {
  return new NodeResolver(sessionsDir, log);
}

class NodeResolver {
  #sessionsDir;
  #log;
  /** 缓存: sessionId → filename mapping */
  #sessionFileCache = null;

  constructor(sessionsDir, log) {
    this.#sessionsDir = sessionsDir;
    this.#log = log;
  }

  /**
   * 根据 node_id 解析原文
   * @param {string} nodeId - "sessionId:messageId"
   * @param {object} [opts]
   * @param {number} [opts.contextLines] - 返回上下文行数（前后各取 N 条）
   * @returns {Promise<object|null>} { nodeId, sessionId, messageId, role, text, prev?: string, next?: string, timestamp }
   */
  async resolve(nodeId, opts = {}) {
    const parsed = parseNodeId(nodeId);
    if (!parsed) return null;

    const { sessionId, messageId } = parsed;
    const filePath = await this.#findSessionFile(sessionId);
    if (!filePath) {
      this.#log?.warn(`[node-resolver] session file not found: ${sessionId}`);
      return null;
    }

    return this.#findMessageInFile(filePath, messageId, opts.contextLines || 0);
  }

  /**
   * 根据消息 ID 直接在会话文件中查找消息
   * （适用于已知 session 但不知道 messageId 的场景）
   */
  async findMessageById(sessionId, messageId, contextLines = 0) {
    const filePath = await this.#findSessionFile(sessionId);
    if (!filePath) return null;
    return this.#findMessageInFile(filePath, messageId, contextLines);
  }

  /**
   * 获取某条消息周边的上下文消息
   */
  async getMessageContext(sessionId, messageId, beforeCount = 3, afterCount = 3) {
    const filePath = await this.#findSessionFile(sessionId);
    if (!filePath) return [];

    const events = [];
    const rl = createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

    let targetIdx = -1;
    let idx = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "message") {
          events.push(evt);
          if (evt.id === messageId) targetIdx = idx;
          idx++;
        }
      } catch {}
    }

    if (targetIdx === -1) return [];

    const start = Math.max(0, targetIdx - beforeCount);
    const end = Math.min(events.length, targetIdx + afterCount + 1);
    return events.slice(start, end).map(e => ({
      nodeId: `${sessionId}:${e.id}`,
      role: e.message?.role,
      text: extractMessageText(e),
      timestamp: e.timestamp,
    }));
  }

  /**
   * 批量解析多个 node_id
   */
  async resolveBatch(nodeIds) {
    const results = [];
    for (const nid of nodeIds) {
      const result = await this.resolve(nid);
      if (result) results.push(result);
    }
    return results;
  }

  /**
   * 从会话文件中提取关键消息的 node_id 列表
   * @returns {{ firstUserNodeId: string|null, errorNodeIds: string[], correctionNodeIds: string[] }}
   */
  async extractKeyNodeIds(sessionId, maxErrors = 3, maxCorrections = 3) {
    const filePath = await this.#findSessionFile(sessionId);
    if (!filePath) return { firstUserNodeId: null, errorNodeIds: [], correctionNodeIds: [] };

    let firstUserNodeId = null;
    const errorNodeIds = [];
    const correctionNodeIds = [];

    const rl = createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type !== "message" && evt.type !== "toolResult" && evt.type !== "error_event") continue;

        const nodeId = `${sessionId}:${evt.id || "?"}`;

        // 第一条 user 消息
        if (!firstUserNodeId && evt.type === "message" && evt.message?.role === "user") {
          firstUserNodeId = nodeId;
        }

        // 工具执行错误
        if (evt.type === "error_event" || (evt.type === "toolResult" && evt.isError)) {
          if (errorNodeIds.length < maxErrors) errorNodeIds.push(nodeId);
        }

        // 用户纠正消息
        if (evt.type === "message" && evt.message?.role === "user") {
          const text = extractMessageText(evt);
          if (/不对|错了|不是|应该|忘了|之前说|纠正|改一下|重新|换个方式|你没听明白|我不是这个意思/i.test(text)) {
            if (correctionNodeIds.length < maxCorrections) correctionNodeIds.push(nodeId);
          }
        }
      } catch {}
    }

    return { firstUserNodeId, errorNodeIds, correctionNodeIds };
  }

  /**
   * 重建 session_id → 文件名 映射缓存
   */
  async rebuildCache() {
    this.#sessionFileCache = new Map();
    await this.#walkSessionsDir(this.#sessionsDir);
    this.#log?.info(`[node-resolver] cache rebuilt: ${this.#sessionFileCache.size} sessions`);
  }

  /**
   * 清除缓存（当扫描周期结束时调用）
   */
  clearCache() {
    this.#sessionFileCache = null;
  }

  // ── 内部方法 ──

  /** 在指定文件的 JSONL 中查找消息 */
  async #findMessageInFile(filePath, messageId, contextLines) {
    const rl = createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

    const ctx = { before: [], target: null, after: [] };
    let found = false;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type !== "message") continue;

        if (found) {
          if (contextLines > 0 && ctx.after.length < contextLines) {
            ctx.after.push(extractMessageText(evt));
          }
          continue;
        }

        if (evt.id === messageId) {
          found = true;
          ctx.target = {
            nodeId: `${extractSessionIdFromFilename(filePath)}:${evt.id}`,
            sessionId: extractSessionIdFromFilename(filePath),
            messageId: evt.id,
            role: evt.message?.role || "unknown",
            text: extractMessageText(evt),
            timestamp: evt.timestamp,
          };
        } else if (contextLines > 0 && ctx.before.length < contextLines) {
          ctx.before.push(extractMessageText(evt));
        }
      } catch {}
    }

    if (!ctx.target) return null;

    return {
      ...ctx.target,
      prev: ctx.before.reverse(),
      next: contextLines > 0 ? ctx.after : undefined,
    };
  }

  /** 按 sessionId 找文件 */
  async #findSessionFile(sessionId) {
    if (!this.#sessionFileCache) await this.rebuildCache();
    return this.#sessionFileCache?.get(sessionId) || null;
  }

  /** 遍历会话目录，建立 sessionId → 文件名 映射 */
  async #walkSessionsDir(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "bridge" || entry.name === "channel-temp") continue;
        await this.#walkSessionsDir(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const sessionId = extractSessionIdFromFilename(entry.name);
        if (sessionId && sessionId !== "unknown") {
          // 短 sessionId（前 8 位）也做映射，方便搜索
          const shortId = sessionId.length >= 8 ? sessionId.slice(0, 8) : sessionId;
          if (!this.#sessionFileCache.has(sessionId)) {
            this.#sessionFileCache.set(sessionId, full);
          }
          if (sessionId !== shortId && !this.#sessionFileCache.has(shortId)) {
            this.#sessionFileCache.set(shortId, full);
          }
        }
      }
    }
  }
}

// ── 工具函数 ──

/** 从 message 事件中提取纯文本 */
function extractMessageText(evt) {
  if (!evt?.message?.content) return "";
  const content = evt.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("\n")
      .slice(0, 500); // 限制长度，避免工具日志污染
  }
  return "";
}
