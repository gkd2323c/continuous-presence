/**
 * continuous-presence/lib/session-scanner.js
 *
 * 扫描 hanako 的会话 .jsonl 文件，构建可检索的经验索引。
 * 不修改任何文件，只读。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const INDEX_VERSION = 3;

/**
 * @param {object} opts
 * @param {string} opts.agentsDir     - ~/.hanako/agents/
 * @param {string} opts.agentId       - 目标 agent id（默认 'hanako'）
 * @param {string} opts.indexDir      - 索引存储目录（plugin-data 下）
 * @param {object} opts.log           - logger
 * @returns {Promise<SessionScanner>}
 */
export async function createScanner({ agentsDir, agentId = "hanako", indexDir, log }) {
  const sessionsDir = path.join(agentsDir, agentId, "sessions");
  const indexFile = path.join(indexDir, "index.json");
  const metaFile = path.join(sessionsDir, "session-titles.json");

  // 确保索引目录存在
  await fsp.mkdir(indexDir, { recursive: true });

  const scanner = new SessionScanner(sessionsDir, metaFile, indexFile, log);
  await scanner.loadIndex();
  return scanner;
}

class SessionScanner {
  #sessionsDir;
  #metaFile;
  #indexFile;
  #log;
  #index;

  constructor(sessionsDir, metaFile, indexFile, log) {
    this.#sessionsDir = sessionsDir;
    this.#metaFile = metaFile;
    this.#indexFile = indexFile;
    this.#log = log;
    this.#index = null;
  }

  // ── 公开方法 ──

  /** 返回当前索引副本（浅拷贝） */
  getIndex() {
    return this.#index ? structuredClone(this.#index) : null;
  }

  /** 全量扫描：发现新文件并解析 */
  async scan() {
    if (!fs.existsSync(this.#sessionsDir)) {
      this.#log.warn(`sessions dir not found: ${this.#sessionsDir}`);
      return;
    }

    const titles = await this.#loadTitles();
    const known = this.#index?.sessions || {};

    // 收集所有 .jsonl 文件（活跃 + 归档）
    const files = await this.#collectJsonlFiles();
    let changed = false;

    for (const filePath of files) {
      const relPath = path.relative(this.#sessionsDir, filePath);
      // 跳过已索引且未变更的文件
      const stat = await fsp.stat(filePath);
      const knownEntry = known[relPath];
      if (knownEntry && knownEntry.mtimeMs === stat.mtimeMs) continue;

      this.#log.info(`scanning session: ${relPath}`);
      const parsed = await this.#parseSessionFile(filePath, stat);
      // 先精确路径匹配，再按文件名匹配（归档会话路径变了）
      let matchedTitle = titles[filePath];
      if (!matchedTitle) {
        const baseName = path.basename(filePath);
        for (const [key, val] of Object.entries(titles)) {
          if (key.endsWith(baseName)) {
            matchedTitle = val;
            break;
          }
        }
      }
      parsed.title = matchedTitle || parsed.title || "";
      known[relPath] = parsed;
      changed = true;
    }

    if (changed) {
      this.#index = {
        version: INDEX_VERSION,
        lastScan: new Date().toISOString(),
        sessions: known,
      };
      await this.#saveIndex();
      this.#log.info(`index updated: ${Object.keys(known).length} sessions`);
    }

    return this.#index;
  }

  /** 增量扫描：只处理新变更的文件 */
  async scanIncremental() {
    if (!fs.existsSync(this.#sessionsDir)) return;
    const titles = await this.#loadTitles();
    const known = this.#index?.sessions || {};
    const files = await this.#collectJsonlFiles();
    let changed = false;

    for (const filePath of files) {
      const relPath = path.relative(this.#sessionsDir, filePath);
      const stat = await fsp.stat(filePath);
      const knownEntry = known[relPath];
      if (knownEntry && knownEntry.mtimeMs === stat.mtimeMs) continue;

      this.#log.info(`incremental scan: ${relPath}`);
      const parsed = await this.#parseSessionFile(filePath, stat);
      let matchedTitle = titles[filePath];
      if (!matchedTitle) {
        const baseName = path.basename(filePath);
        for (const [key, val] of Object.entries(titles)) {
          if (key.endsWith(baseName)) {
            matchedTitle = val;
            break;
          }
        }
      }
      parsed.title = matchedTitle || "";
      known[relPath] = parsed;
      changed = true;
    }

    if (changed) {
      this.#index.lastScan = new Date().toISOString();
      this.#index.sessions = known;
      await this.#saveIndex();
    }
  }

  // ── 内部方法 ──

  async loadIndex() {
    try {
      const raw = await fsp.readFile(this.#indexFile, "utf-8");
      this.#index = JSON.parse(raw);
      if (this.#index.version !== INDEX_VERSION) {
        this.#log.info(`index version mismatch (got ${this.#index.version}), re-scanning`);
        this.#index = null;
      }
    } catch {
      this.#index = null;
    }
    if (!this.#index) {
      this.#index = { version: INDEX_VERSION, lastScan: null, sessions: {} };
    }
  }

  async #saveIndex() {
    await fsp.writeFile(this.#indexFile, JSON.stringify(this.#index, null, 2), "utf-8");
  }

  async #loadTitles() {
    try {
      const raw = await fsp.readFile(this.#metaFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async #collectJsonlFiles() {
    const results = [];

    async function walk(dir) {
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
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(full);
        }
      }
    }

    await walk(this.#sessionsDir);
    return results;
  }

  async #parseSessionFile(filePath, stat) {
    const rl = createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

    const result = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      timestamp: null,
      cwd: null,
      title: "",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolsUsed: new Set(),
      toolSequence: [],
      errors: [],
      corrections: [],
      exchangeCount: 0,
      userTopics: [],
      summary: "",
    };

    let firstUserText = "";

    for await (const line of rl) {
      if (!line.trim()) continue;

      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      switch (evt.type) {
        case "session": {
          result.timestamp = evt.timestamp;
          result.cwd = evt.cwd || null;
          break;
        }
        case "message": {
          const msg = evt.message;
          if (!msg) break;

          result.exchangeCount++;

          if (msg.role === "user") {
            result.userMessages++;
            const text = extractText(msg.content);
            if (text && !firstUserText) {
              firstUserText = text.slice(0, 120);
            }
            // 检测用户纠正
            if (isCorrection(text)) {
              result.corrections.push({
                text: text.slice(0, 200),
                timestamp: evt.timestamp,
              });
            }
          } else if (msg.role === "assistant") {
            result.assistantMessages++;
            // 提取工具调用
            const calls = extractToolCalls(msg.content);
            for (const tc of calls) {
              result.toolsUsed.add(tc.name);
              result.toolSequence.push(tc.name);
              result.toolCalls++;
            }
          } else if (msg.role === "toolResult") {
            if (msg.isError) {
              result.errors.push({
                tool: msg.toolName || "unknown",
                error: extractText(msg.content).slice(0, 300),
                timestamp: evt.timestamp,
              });
            }
          }
          break;
        }
      }
    }

    // 整理输出
    result.toolsUsed = [...result.toolsUsed].sort();
    result.userTopics = extractTopics(firstUserText);
    result.summary = firstUserText.slice(0, 200);

    this.#log.info(
      `  parsed: ${result.exchangeCount} exchanges, ` +
      `${result.toolsUsed.length} tools, ` +
      `${result.errors.length} errors, ` +
      `${result.corrections.length} corrections`
    );

    return result;
  }
}

// ── 纯函数工具 ──

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .trim();
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c.type === "toolCall" && c.name)
    .map((c) => ({ name: c.name, args: c.arguments }));
}

/** 检测用户消息是否包含纠正/指正 */
function isCorrection(text) {
  if (!text) return false;
  const patterns = [
    /不对[，。！\s]/, /不是[，。！\s]/, /错了[，。！\s]/,
    /应该[是用用]/, /正确的[做法方式]/,
    /以后[要用]/, /别[用][^。]{0,20}/,
  ];
  return patterns.some((p) => p.test(text));
}

/** 从首条用户消息中提取话题关键词 */
function extractTopics(text) {
  if (!text) return [];
  // 简单分词：根据空格/标点切分，去除常见停用词
  const stopWords = new Set([
    "的", "了", "是", "在", "有", "和", "就", "不", "也", "都",
    "这", "那", "你", "我", "他", "她", "它", "们", "什么", "怎么",
    "为什么", "如何", "能", "吗", "吧", "啊", "呢", "一个", "没有",
    "可以", "这个", "那个", "把", "被", "让", "给", "对", "到", "从",
    "a", "an", "the", "is", "are", "was", "were", "to", "in", "of",
    "for", "with", "on", "at", "by", "do", "does", "did", "have",
  ]);
  // 提取中英文单词
  const tokens = text.match(/[\w\u4e00-\u9fff]+/g) || [];
  const counts = new Map();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (stopWords.has(lower)) continue;
    if (token.length < 2) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  // 按频率降序，取前 5
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}
