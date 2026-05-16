/**
 * continuous-presence/lib/scene-builder.js
 *
 * L2 Scene Blocks（场景块）—— 将相关会话聚合成主题化的 Markdown 场景块。
 * 介于 L0 (原始会话) 和 L3 (用户画像) 之间，提供可读、可追溯的中间层。
 *
 * 设计原则：
 * - 每个场景块是一个 Markdown 文件，包含 YAML frontmatter
 * - 场景块按话题聚合相关会话，提炼关键知识点、工具模式和关联经验
 * - 与 continuous-presence 的索引联动，增量更新
 * - 场景块本身可检索、可手动修改，不做黑盒
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const SCENE_INDEX_VERSION = 1;

// ── 公共 API ──

/**
 * 创建场景块管理器
 * @param {object} opts
 * @param {string} opts.sceneDir   - scene_blocks 存储目录
 * @param {object} opts.log        - logger
 * @returns {Promise<SceneBuilder>}
 */
export async function createSceneBuilder({ sceneDir, log }) {
  await fsp.mkdir(sceneDir, { recursive: true });
  const builder = new SceneBuilder(sceneDir, log);
  await builder.loadIndex();
  return builder;
}

class SceneBuilder {
  #sceneDir;
  #log;
  #index;  // { version, scenes: { [id]: metadata } }

  constructor(sceneDir, log) {
    this.#sceneDir = sceneDir;
    this.#log = log;
    this.#index = null;
  }

  // ── 公开方法 ──

  /** 获取场景索引副本 */
  getIndex() {
    return this.#index ? structuredClone(this.#index) : null;
  }

  /** 获取指定场景块的 Markdown 内容 */
  async getSceneContent(sceneId) {
    const filePath = path.join(this.#sceneDir, `${sanitizeId(sceneId)}.md`);
    try {
      return await fsp.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /** 列出所有场景块摘要 */
  listScenes() {
    if (!this.#index?.scenes) return [];
    return Object.values(this.#index.scenes)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  }

  /**
   * 根据 continuous-presence 的索引更新场景块
   * @param {object} index - continuous-presence 的完整索引
   * @param {number} maxScenes - 最多保留多少个场景块
   */
  async updateFromSessionIndex(index, maxScenes = 30) {
    const sessions = index?.sessions || {};
    const sessionList = Object.values(sessions).filter(s => s && s.exchangeCount > 0);

    if (sessionList.length === 0) {
      this.#log.info("[scene-builder] no sessions to process");
      return;
    }

    this.#log.info(`[scene-builder] processing ${sessionList.length} sessions for scene clustering`);

    // 1. 从会话中提取关键词和特征向量
    const sessionVectors = sessionList.map(s => this.#extractSessionFeatures(s));

    // 2. 基于相似度聚类
    const clusters = this.#clusterSessions(sessionVectors);

    this.#log.info(`[scene-builder] found ${clusters.length} topic clusters`);

    // 3. 为每个聚类生成/更新场景块
    const existingScenes = this.#index?.scenes || {};
    const updatedScenes = {};

    for (const cluster of clusters) {
      if (cluster.sessions.length < 1) continue;

      const sceneId = this.#deriveSceneId(cluster);
      const scene = await this.#buildSceneBlock(sceneId, cluster, sessions, existingScenes[sceneId]);
      if (scene) {
        updatedScenes[sceneId] = scene.meta;
        await this.#writeSceneBlock(sceneId, scene.content);
      }
    }

    // 4. 清理不再活跃的场景块（不删除，只是从索引中降级）
    //    保留已有的场景块文件，标记为 archived
    for (const [existingId, existingMeta] of Object.entries(existingScenes)) {
      if (!updatedScenes[existingId]) {
        // 保留文件但标记为归档
        updatedScenes[existingId] = {
          ...existingMeta,
          archived: true,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // 5. 按重要性排序，只保留 top N
    const sorted = Object.entries(updatedScenes)
      .sort(([, a], [, b]) => (b.importance || 0) - (a.importance || 0))
      .slice(0, maxScenes);

    const keptScenes = Object.fromEntries(sorted);
    this.#index = {
      version: SCENE_INDEX_VERSION,
      lastUpdate: new Date().toISOString(),
      totalSessions: sessionList.length,
      scenes: keptScenes,
    };

    await this.#saveIndex();
    this.#log.info(`[scene-builder] updated ${Object.keys(keptScenes).length} scene blocks`);
  }

  // ── 内部方法 ──

  /** 加载或初始化场景索引（公开给工厂函数调用） */
  async loadIndex() {
    const indexFile = path.join(this.#sceneDir, "index.json");
    try {
      const raw = await fsp.readFile(indexFile, "utf-8");
      this.#index = JSON.parse(raw);
      if (this.#index.version !== SCENE_INDEX_VERSION) {
        this.#log.info(`[scene-builder] index version mismatch, resetting`);
        this.#index = null;
      }
    } catch {
      this.#index = null;
    }
    if (!this.#index) {
      this.#index = { version: SCENE_INDEX_VERSION, lastUpdate: null, totalSessions: 0, scenes: {} };
    }
  }

  async #saveIndex() {
    const indexFile = path.join(this.#sceneDir, "index.json");
    await fsp.writeFile(indexFile, JSON.stringify(this.#index, null, 2), "utf-8");
  }

  /**
   * 从会话元数据中提取特征向量
   */
  #extractSessionFeatures(session) {
    const topics = (session.userTopics || []).map(t => t.toLowerCase().trim()).filter(Boolean);
    const tools = (session.toolsUsed || []);
    const summary = (session.summary || "").toLowerCase().slice(0, 100);
    const errors = (session.errors || []).map(e => (e.tool || "").toLowerCase());

    // 提取摘要中的有意义的关键词（过滤 URL、路径、数字等杂音）
    const keywords = this.#extractKeywords(summary);

    return {
      topics: new Set(topics),
      tools: new Set(tools),
      keywords: new Set(keywords),
      errors: new Set(errors),
      exchangeCount: session.exchangeCount || 0,
      rawSummary: summary,
    };
  }

  /** 已知噪声词——URL 片段、通用英文词、文件扩展名等 */
  static #NOISE_WORDS = new Set([
    // URL 和协议相关
    "com", "https", "http", "www", "github", "git", "io", "net", "org", "cn",
    "html", "php", "asp", "jsp", "url", "uri", "api", "rest",
    // 文件路径和扩展名
    "exe", "dll", "so", "dmg", "app", "zip", "tar", "gz", "7z",
    "jpg", "jpeg", "png", "gif", "bmp", "svg", "webp",
    "mp3", "mp4", "avi", "mkv", "mov", "wav", "flac",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "js", "ts", "jsx", "tsx", "vue", "py", "rb", "go", "rs", "java",
    "css", "scss", "less", "md", "txt", "log",
    // 操作系统相关
    "users", "windows", "linux", "macos", "darwin", "localhost", "127",
    "appdata", "program", "files", "system32", "temp", "tmp",
    // 通用英文虚词
    "the", "this", "that", "these", "those", "with", "from", "into",
    "during", "before", "after", "above", "below", "between", "other",
    "some", "such", "more", "most", "few", "all", "each", "every",
    "both", "neither", "either", "than", "then", "very", "just",
    "also", "well", "back", "over", "under", "again", "further",
    "about", "across", "along", "among", "around", "behind", "beyond",
    "down", "inside", "near", "off", "onto", "outside", "round",
    "through", "toward", "towards", "upon", "within", "without",
    // 其他噪声
    "env", "http_proxy", "https_proxy", "no_proxy", "proxy",
    "true", "false", "null", "undefined", "nan", "infinity",
    "stdout", "stderr", "stdin", "args", "argv",
  ]);

  /** 已知高频但有意义的词——保留用于相似度计算 */
  static #MEANINGFUL_STOPS = new Set([
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会",
    "没有", "看", "好", "自己", "这", "他", "她", "它", "那",
    "什么", "怎么", "如何", "可以", "需要", "这个", "那个", "还是",
    "因为", "所以", "但是", "如果", "虽然", "而且", "或者", "然后",
    "之后", "目前", "当前", "现在", "之前", "之后", "已经", "已经",
    "可能", "应该", "能够", "需要", "使用", "通过", "进行", "提供",
    "一个", "没有", "不是", "就是", "这个", "那个", "哪些", "这些",
  ]);

  /**
   * 从文本中提取有意义的关键词
   */
  #extractKeywords(text) {
    if (!text) return [];
    // 按非字母字符分割（保留中文、英文）
    const rawWords = text.split(/[\s,;:：；。！？、\(\)（）\[\]【】{}]/);

    const keywords = [];
    for (const word of rawWords) {
      const clean = word.trim();
      if (!clean) continue;
      if (clean.length < 2) continue;
      const lower = clean.toLowerCase();
      if (/^[\d]+$/.test(lower)) continue;             // 纯数字
      if (/^https?:\/\//.test(lower)) continue;         // URL
      if (/^[a-z]:\\/.test(lower) || /^\/[a-z]+\//.test(lower)) continue; // 路径
      if (SceneBuilder.#NOISE_WORDS.has(lower)) continue;
      if (SceneBuilder.#MEANINGFUL_STOPS.has(lower)) continue;
      keywords.push(clean);
    }
    return [...new Set(keywords)].slice(0, 15); // 最多 15 个
  }

  /**
   * 基于 IDF 加权的特征突出聚类
   * 抑制 bash/read/ls 等全通用工具的影响，突出特征性工具和话题
   */
  #clusterSessions(sessionVectors) {
    const n = sessionVectors.length;
    if (n === 0) return [];

    // 1. 计算每个特征在多少会话中出现
    const docFreq = new Map();
    for (const sv of sessionVectors) {
      const seen = new Set();
      for (const t of sv.topics) { if (!seen.has(t)) { docFreq.set(t, (docFreq.get(t) || 0) + 1); seen.add(t); } }
      for (const k of sv.keywords) { if (!seen.has(k)) { docFreq.set(k, (docFreq.get(k) || 0) + 1); seen.add(k); } }
      for (const t of sv.tools) { if (!seen.has(t)) { docFreq.set(t, (docFreq.get(t) || 0) + 1); seen.add(t); } }
    }

    // IDF：log(N/df)，值越大表示该特征越独特
    const getWeight = (feature) => {
      const df = docFreq.get(feature) || 0;
      if (df === 0) return 1;
      // 出现在 60% 以上会话中 → 权重接近 0（太通用）
      // 出现在 1%~20% → 权重高（有区分度）
      // 出现在 20%~60% → 中等权重
      const ratio = df / n;
      if (ratio > 0.6) return 0.05;   // bash、read 级通用工具
      if (ratio > 0.3) return 0.3;    // 较通用但仍有区分度
      if (ratio > 0.1) return 0.7;    // 有区分度
      return 1.0;                      // 稀有特征
    };

    // 2. 为每个会话构建加权特征集
    const weightedFeatures = sessionVectors.map(sv => {
      const features = new Map();
      const addFeature = (item, baseWeight) => {
        const w = getWeight(item) * baseWeight;
        if (w > 0.05) features.set(item, w);
      };
      for (const t of sv.topics) addFeature(t, 1);
      for (const k of sv.keywords) addFeature(k, 1.2);
      for (const t of sv.tools) addFeature(t, 0.8);
      return features;
    });

    // 3. 计算加权相似度矩阵
    const similarities = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.#calcWeightedSimilarity(weightedFeatures[i], weightedFeatures[j]);
        if (sim > 0.3) { // 提高阈值，只有显著相似才连边
          similarities.push({ i, j, sim });
        }
      }
    }

    // 4. 并查集聚类
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) parent[x] = parent[parent[x]], x = parent[x];
      return x;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    similarities.sort((a, b) => b.sim - a.sim);
    for (const { i, j } of similarities) {
      union(i, j);
    }

    // 5. 收集聚类
    const clusterMap = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!clusterMap.has(root)) {
        clusterMap.set(root, { sessionIndices: [], topics: new Set(), tools: new Set(), keywords: new Set(), errors: new Set(), totalExchanges: 0 });
      }
      const c = clusterMap.get(root);
      c.sessionIndices.push(i);
      for (const t of sessionVectors[i].topics) c.topics.add(t);
      for (const t of sessionVectors[i].tools) c.tools.add(t);
      for (const k of sessionVectors[i].keywords) c.keywords.add(k);
      for (const e of sessionVectors[i].errors) c.errors.add(e);
      c.totalExchanges += sessionVectors[i].exchangeCount;
    }

    // 6. 转换为输出，过滤太小聚类
    const clusters = [];
    for (const [, c] of clusterMap) {
      if (c.sessionIndices.length < 1) continue;
      // 单会话聚类必须有明确话题
      if (c.sessionIndices.length === 1 && c.keywords.size < 2 && c.topics.size < 2) continue;

      clusters.push({
        sessions: c.sessionIndices,
        topics: [...c.topics].sort(),
        tools: [...c.tools].sort(),
        keywords: [...c.keywords].sort(),
        errors: [...c.errors],
        totalExchanges: c.totalExchanges,
      });
    }

    clusters.sort((a, b) => b.sessions.length - a.sessions.length);
    return clusters;
  }

  /**
   * 计算两个加权特征集的加权余弦相似度
   */
  #calcWeightedSimilarity(featA, featB) {
    // 计算点积和模长
    let dotProduct = 0, normA = 0, normB = 0;

    for (const [key, weightA] of featA) {
      normA += weightA * weightA;
      const weightB = featB.get(key);
      if (weightB !== undefined) {
        dotProduct += weightA * weightB;
      }
    }
    for (const [, weightB] of featB) {
      normB += weightB * weightB;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dotProduct / denom;
  }

  /**
   * 从聚类中推导场景 ID
   */
  #deriveSceneId(cluster) {
    // 优先使用常见工具组合来命名（更稳定）
    const toolCandidates = [...cluster.tools].filter(t => t.length >= 3 && t.length <= 25);
    if (toolCandidates.length >= 2 && toolCandidates.length <= 4) {
      const base = toolCandidates.slice(0, 2).join('-');
      const safe = sanitizeId(base);
      if (safe.length >= 5) return `scene-${safe}`;
    }

    // 否则用关键词
    const kwFreq = new Map();
    for (const k of cluster.keywords) {
      kwFreq.set(k, (kwFreq.get(k) || 0) + 1);
    }
    for (const t of cluster.topics) {
      if (!t.match(/^[a-z]\\.\\\\|^https?:|^\d+$|^(com|github|https|www|io|net|org|cn)$/i)) {
        kwFreq.set(t, (kwFreq.get(t) || 0) + 3);
      }
    }
    const sorted = [...kwFreq.entries()].sort((a, b) => b[1] - a[1]);
    const best = sorted[0]?.[0];
    if (best && best.length >= 2) {
      const safe = sanitizeId(best);
      return `scene-${safe}`;
    }

    return `scene-${Date.now()}`;
  }

  /**
   * 构建场景块的 Markdown 内容和元数据
   */
  async #buildSceneBlock(sceneId, cluster, sessionsMap, existingMeta) {
    const sessionIndices = cluster.sessions;
    const clusterSessions = sessionIndices.map(i => {
      const allSessions = Object.values(sessionsMap);
      return allSessions[i];
    }).filter(Boolean);

    if (clusterSessions.length === 0) return null;

    // 决定标题：优先使用出现最多的有意义话题/关键词
    const topicFreq = new Map();
    for (const t of cluster.topics) {
      const lower = t.toLowerCase();
      if (!SceneBuilder.#NOISE_WORDS.has(lower) && !SceneBuilder.#MEANINGFUL_STOPS.has(lower) && t.length >= 2) {
        topicFreq.set(t, (topicFreq.get(t) || 0) + 3);
      }
    }
    for (const k of cluster.keywords) {
      const lower = k.toLowerCase();
      if (!SceneBuilder.#NOISE_WORDS.has(lower) && !SceneBuilder.#MEANINGFUL_STOPS.has(lower) && k.length >= 2) {
        topicFreq.set(k, (topicFreq.get(k) || 0) + 1);
      }
    }
    const sortedTopics = [...topicFreq.entries()].sort((a, b) => b[1] - a[1]);
    const title = sortedTopics[0]?.[0] || "未命名场景";

    // 计算重要性：会话数量 + 工具多样性 + 错误数量
    const sessionCount = clusterSessions.length;
    const toolCount = cluster.tools.length;
    const errorCount = cluster.errors.length;
    const importance = Math.min(10, Math.max(1,
      Math.round(
        sessionCount / 3 +    // 每 3 个会话 +1
        toolCount / 2 +        // 每 2 个工具 +1
        Math.min(errorCount, 3) // 最多 +3
      )
    ));

    // 提取所有会话的文件名（用于可追溯引用）
    const sessionRefs = clusterSessions.map(s => {
      // 从 sessionsMap 中找到这个会话的 key
      for (const [key, val] of Object.entries(sessionsMap)) {
        if (val === s) return key;
      }
      return null;
    }).filter(Boolean);

    // 提取共性工具模式和常见错误
    const toolPatterns = this.#extractToolPatterns(clusterSessions);
    const commonErrors = this.#extractCommonErrors(clusterSessions);

    // 拼凑摘要
    const summaries = clusterSessions.map(s => s.summary).filter(Boolean);
    const sceneSummary = summaries.length > 0
      ? summaries.slice(0, 5).join("；")
      : `涉及 ${sessionCount} 次相关对话`;

    // 元数据
    const meta = {
      id: sceneId,
      title,
      topics: sortedTopics.slice(0, 10).map(([t]) => t),
      tools: cluster.tools.slice(0, 20),
      importance,
      sessions: sessionRefs.length,
      totalExchanges: cluster.totalExchanges,
      errors: errorCount,
      createdAt: existingMeta?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: existingMeta?.archived || false,
    };

    // Markdown 正文
    const lines = [];
    lines.push("---");
    lines.push(`id: ${meta.id}`);
    lines.push(`title: ${meta.title}`);
    lines.push(`topics: [${meta.topics.map(t => JSON.stringify(t)).join(", ")}]`);
    lines.push(`tools: [${meta.tools.map(t => JSON.stringify(t)).join(", ")}]`);
    lines.push(`importance: ${meta.importance}`);
    lines.push(`created: ${meta.createdAt}`);
    lines.push(`updated: ${meta.updatedAt}`);
    lines.push(`sessions: ${meta.sessions}`);
    lines.push(`exchanges: ${meta.totalExchanges}`);
    lines.push(`errors: ${meta.errors}`);
    if (meta.archived) lines.push(`archived: true`);
    lines.push("---");
    lines.push("");
    lines.push(`# ${meta.title}`);
    lines.push("");
    lines.push("## 场景概述");
    lines.push("");
    lines.push(sceneSummary);
    lines.push("");

    // 关键话题
    if (meta.topics.length > 0) {
      lines.push("## 核心话题");
      lines.push("");
      for (const t of meta.topics.slice(0, 8)) {
        lines.push(`- ${t}`);
      }
      lines.push("");
    }

    // 工具模式
    if (toolPatterns.length > 0) {
      lines.push("## 工具使用模式");
      lines.push("");
      for (const pattern of toolPatterns.slice(0, 5)) {
        const seq = pattern.sequence.join(" → ");
        const count = pattern.count;
        lines.push(`- \`${seq}\`（${count} 次会话）`);
      }
      lines.push("");
    }

    // 常见错误
    if (commonErrors.length > 0) {
      lines.push("## 常见踩坑");
      lines.push("");
      for (const err of commonErrors.slice(0, 5)) {
        lines.push(`- **${err.tool}**：${err.error.slice(0, 120)}`);
      }
      lines.push("");
    }

    // 相关会话（含 node_id 可追溯引用）
    if (sessionRefs.length > 0) {
      lines.push("## 相关会话");
      lines.push("");
      for (const ref of sessionRefs.slice(0, 10)) {
        const session = sessionsMap[ref];
        const date = session?.timestamp
          ? new Date(session.timestamp).toLocaleDateString("zh-CN")
          : "?";
        const title = session?.title || "(无标题)";
        // 从文件路径提取 session_id 用于 node_id 追溯
        const sessionId = extractSessionIdFromPath(ref);
        lines.push(`- [${date}] ${title}`);
        lines.push(`  - 文件: \`${ref}\``);
        if (sessionId) {
          lines.push(`  - 追溯: \`node:${sessionId}:first-msg\``);
        }
        if (session?.errors?.length) {
          lines.push(`  - 踩坑: ${session.errors.length} 个`);
        }
      }
      lines.push("");
    }

    // 可追溯来源汇总
    if (sessionRefs.length > 1) {
      const allSessionIds = sessionRefs
        .map(ref => extractSessionIdFromPath(ref))
        .filter(Boolean);
      if (allSessionIds.length > 0) {
        lines.push("## 可追溯来源");
        lines.push("");
        lines.push("每条消息可通过 \`node:{sessionId}:{messageId}\` 格式追溯原文。");
        lines.push("使用 \`resolve-node\` 工具传入 node_id 即可获取消息原文。");
        lines.push("");
        lines.push("涉及会话：");
        for (const sid of allSessionIds.slice(0, 10)) {
          lines.push(`- \`${sid}\``);
        }
        lines.push("");
      }
    }

    return { meta, content: lines.join("\n") };
  }

  /**
   * 从一组会话中提取共性工具序列模式
   */
  #extractToolPatterns(sessions) {
    const patternMap = new Map();

    for (const s of sessions) {
      const seq = s.toolSequence || [];
      if (seq.length < 2) continue;

      // 提取长度为 2-3 的子序列作为模式
      for (let len = 2; len <= Math.min(3, seq.length); len++) {
        for (let i = 0; i <= seq.length - len; i++) {
          const sub = seq.slice(i, i + len);
          const key = sub.join("::");
          if (!patternMap.has(key)) {
            patternMap.set(key, { sequence: sub, count: 0, sessions: new Set() });
          }
          patternMap.get(key).count++;
        }
      }
    }

    return [...patternMap.values()]
      .filter(p => p.count >= 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * 从一组会话中提取常见错误
   */
  #extractCommonErrors(sessions) {
    const errorMap = new Map();

    for (const s of sessions) {
      for (const e of (s.errors || [])) {
        const key = `${e.tool}::${(e.error || "").slice(0, 60)}`;
        if (!errorMap.has(key)) {
          errorMap.set(key, { tool: e.tool, error: e.error || "", count: 0 });
        }
        errorMap.get(key).count++;
      }
    }

    return [...errorMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * 写入场景块 Markdown 文件
   */
  async #writeSceneBlock(sceneId, content) {
    const filePath = path.join(this.#sceneDir, `${sanitizeId(sceneId)}.md`);
    await fsp.writeFile(filePath, content, "utf-8");
  }
}

// ── 工具函数 ──

/** 将场景 ID 转换为安全的文件名 */
function sanitizeId(id) {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * 从会话文件路径中提取 session_id（UUID 部分）
 * @param {string} filePath - 如 "archived\\2026-05-07T04-57-28-199Z_019e00cc-....jsonl"
 * @returns {string|null}
 */
function extractSessionIdFromPath(filePath) {
  const base = filePath.replace(/\.jsonl$/i, "").split(/[\\\/]/).pop() || "";
  const parts = base.split("_");
  // 从末尾往前找 UUID
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)) {
      return p;
    }
  }
  // fallback: 取最后一段
  return parts.length > 1 ? parts.slice(1).join("_") : parts[0] || null;
}
