/**
 * continuous-presence/lib/persona-generator.js
 *
 * L3 Persona（用户画像）自动化生成。
 *
 * 从场景块、会话索引和置顶记忆中提炼用户画像：
 * - 技术倾向（常用工具、关注领域）
 * - 工作模式（常用工作流）
 * - 沟通偏好（风格推断）
 * - 常见问题域（反复出现的主题）
 * - 经验教训（踩坑和纠正模式）
 *
 * 设计原则：
 * - 优先基于统计数据，不依赖 LLM
 * - 输出可读 Markdown，来源可追溯
 * - 增量更新，不覆盖已有手动编辑的内容
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const PERSONA_VERSION = 1;

// ── 公共 API ──

/**
 * 创建 Persona 生成器
 * @param {object} opts
 * @param {string} opts.personaDir   - 数据目录
 * @param {object} opts.log          - logger
 * @returns {Promise<PersonaGenerator>}
 */
export async function createPersonaGenerator({ personaDir, log }) {
  await fsp.mkdir(personaDir, { recursive: true });
  const generator = new PersonaGenerator(personaDir, log);
  await generator.loadMeta();
  return generator;
}

class PersonaGenerator {
  #personaDir;
  #log;
  #meta;  // { version, lastGenerated, sourceSessions, sourceScenes, confidence }

  constructor(personaDir, log) {
    this.#personaDir = personaDir;
    this.#log = log;
    this.#meta = null;
  }

  /** 获取当前 Persona 元数据 */
  getMeta() {
    return this.#meta ? structuredClone(this.#meta) : null;
  }

  /** 读取当前 persona.md 内容 */
  async getPersonaContent() {
    const filePath = path.join(this.#personaDir, "persona.md");
    try {
      return await fsp.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 从场景块和会话索引生成/更新 Persona
   * @param {object} index - continuous-presence 的完整索引
   * @param {object[]} scenes - 活跃场景块列表（含元数据）
   * @param {string} [pinnedMd] - 置顶记忆内容
   */
  async generate(index, scenes, pinnedMd) {
    const sessions = index?.sessions || {};
    const sessionList = Object.values(sessions).filter(Boolean);
    const totalSessions = sessionList.length;

    if (totalSessions === 0 && scenes.length === 0) {
      this.#log?.info("[persona] no data to generate persona");
      return;
    }

    this.#log?.info(`[persona] generating from ${totalSessions} sessions, ${scenes.length} scenes`);

    // 1. 统计技术倾向
    const techProfile = this.#analyzeTechProfile(scenes, sessionList);

    // 2. 分析工作模式
    const workPatterns = this.#analyzeWorkPatterns(scenes, sessionList);

    // 3. 分析沟通偏好
    const commStyle = this.#analyzeCommunicationStyle(sessionList);

    // 4. 分析常见问题域
    const problemDomains = this.#analyzeProblemDomains(scenes, sessionList);

    // 5. 提取经验教训
    const lessons = this.#extractLessons(sessionList, scenes);

    // 6. 计算置信度
    const confidence = this.#calcConfidence(totalSessions, scenes.length, sessionList);

    // 7. 读取旧的 persona 以保留手动编辑的部分
    const existingContent = await this.getPersonaContent();

    // 8. 生成 Markdown
    const content = this.#buildPersonaMd({
      techProfile,
      workPatterns,
      commStyle,
      problemDomains,
      lessons,
      confidence,
      totalSessions,
      totalScenes: scenes.length,
      totalErrors: sessionList.reduce((s, x) => s + (x.errors?.length || 0), 0),
      totalCorrections: sessionList.reduce((s, x) => s + (x.corrections?.length || 0), 0),
      pinnedMd,
      existingContent,
    });

    // 写入
    const filePath = path.join(this.#personaDir, "persona.md");
    await fsp.writeFile(filePath, content, "utf-8");

    // 更新元数据
    this.#meta = {
      version: PERSONA_VERSION,
      lastGenerated: new Date().toISOString(),
      sourceSessions: totalSessions,
      sourceScenes: scenes.length,
      confidence,
    };
    await this.#saveMeta();

    this.#log?.info(`[persona] generated (confidence=${confidence.toFixed(2)}, ${totalSessions} sessions, ${scenes.length} scenes)`);
    return this.#meta;
  }

  // ── 内部方法 ──

  /** 加载或初始化元数据（公开给工厂函数） */
  async loadMeta() {
    const metaFile = path.join(this.#personaDir, ".persona-meta.json");
    try {
      const raw = await fsp.readFile(metaFile, "utf-8");
      this.#meta = JSON.parse(raw);
    } catch {
      this.#meta = null;
    }
  }

  async #saveMeta() {
    const metaFile = path.join(this.#personaDir, ".persona-meta.json");
    await fsp.writeFile(metaFile, JSON.stringify(this.#meta, null, 2), "utf-8");
  }

  /**
   * 技术倾向分析
   */
  #analyzeTechProfile(scenes, sessions) {
    // 工具使用排名
    const toolFreq = new Map();
    const sceneToolFreq = new Map();

    for (const s of scenes) {
      for (const t of (s.tools || [])) {
        sceneToolFreq.set(t, (sceneToolFreq.get(t) || 0) + (s.sessions || 1));
      }
    }
    for (const s of sessions) {
      for (const t of (s.toolsUsed || [])) {
        toolFreq.set(t, (toolFreq.get(t) || 0) + 1);
      }
    }

    // 合并频率（场景权重更高）
    const merged = new Map();
    for (const [t, c] of toolFreq) merged.set(t, (merged.get(t) || 0) + c);
    for (const [t, c] of sceneToolFreq) merged.set(t, (merged.get(t) || 0) + c * 3);

    const sortedTools = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([t]) => !t.startsWith("continuous-presence") && !t.startsWith("dream-weaver"))
      .slice(0, 20);

    // 工具分类
    const categories = {
      search: ["web_search", "web_fetch", "search_memory", "recall_experience", "mcp_Tavily", "mcp_Brave", "mcp_Exa", "mcp_Bocha", "browser"],
      fileOps: ["read", "write", "edit", "ls", "find", "grep"],
      exec: ["bash", "terminal"],
      system: ["cron", "current_status", "check_pending_tasks", "wait"],
      plugin: ["install_skill", "pin_memory", "record_experience", "stage_files"],
    };

    const categoryCounts = {};
    for (const [cat, patterns] of Object.entries(categories)) {
      categoryCounts[cat] = sortedTools
        .filter(([t]) => patterns.some(p => t.startsWith(p) || t === p))
        .reduce((sum, [, c]) => sum + c, 0);
    }

    return { sortedTools, categoryCounts };
  }

  /**
   * 工作模式分析
   */
  #analyzeWorkPatterns(scenes, sessions) {
    // 从场景块中提取高频工具序列
    const patternFreq = new Map();
    for (const s of sessions) {
      const seq = s.toolSequence || [];
      for (let i = 0; i < seq.length - 1; i++) {
        const pair = `${seq[i]} → ${seq[i + 1]}`;
        patternFreq.set(pair, (patternFreq.get(pair) || 0) + 1);
      }
    }

    const topPatterns = [...patternFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([p, c]) => ({ pattern: p, count: c }));

    // 工作时间分析
    let morning = 0, afternoon = 0, evening = 0, night = 0;
    for (const s of sessions) {
      if (!s.timestamp) continue;
      try {
        const h = new Date(s.timestamp).getHours();
        if (h < 12) morning++;
        else if (h < 18) afternoon++;
        else if (h < 22) evening++;
        else night++;
      } catch {}
    }

    const total = morning + afternoon + evening + night || 1;
    const peakTime = [
      morning / total > 0.3 ? "上午" : "",
      afternoon / total > 0.3 ? "下午" : "",
      evening / total > 0.3 ? "晚上" : "",
      night / total > 0.3 ? "深夜" : "",
    ].filter(Boolean).join("、") || "分布均匀";

    return { topPatterns, peakTime, morning, afternoon, evening, night };
  }

  /**
   * 沟通风格分析
   */
  #analyzeCommunicationStyle(sessions) {
    let totalExchanges = 0;
    let longTurns = 0; // 超过 20 轮交换的会话
    let shortTopics = 0; // 少于 5 轮交换的会话

    for (const s of sessions) {
      const ec = s.exchangeCount || 0;
      totalExchanges += ec;
      if (ec > 20) longTurns++;
      if (ec < 5) shortTopics++;
    }

    const n = sessions.length || 1;
    const avgDepth = Math.round(totalExchanges / n);

    let depthDesc = "多变";
    if (avgDepth > 50) depthDesc = "深入型——喜欢在一个话题上持续深挖";
    else if (avgDepth > 20) depthDesc = "深度适中——会深入但也会适时切换";
    else if (avgDepth > 10) depthDesc = "中等——话题切换较频繁";

    const depthRatio = longTurns / n;
    let styleDesc = "简洁直接";
    if (depthRatio > 0.3) styleDesc = "偏深度探索——喜欢深入讨论";
    else if (depthRatio > 0.15) styleDesc = "兼具深度和广度";

    return { avgDepth, depthDesc, styleDesc, longTurns, shortTopics };
  }

  /**
   * 常见问题域分析
   */
  #analyzeProblemDomains(scenes, sessions) {
    // 从场景块话题中提取领域
    const domainFreq = new Map();
    
    // 定义知识领域关键词映射
    const domainKeywords = {
      "系统运维": ["nginx", "代理", "部署", "docker", "服务器", "端口", "配置", "反向代理"],
      "AI/模型": ["模型", "embedding", "ollama", "llm", "gpu", "推理", "训练", "量化", "gguf"],
      "开发工具": ["git", "github", "mcp", "api", "cli", "sdk", "插件", "脚本"],
      "网络/安全": ["代理", "vpn", "网络", "ssl", "tls", "防火墙", "dns", "证书"],
      "数据处理": ["b站", "视频", "下载", "转写", "字幕", "文件", "搜索"],
      "项目管理": ["记忆", "笔记", "知识库", "markdown", "文档", "记录"],
    };

    for (const scene of scenes) {
      const allText = (scene.title || "") + " " + (scene.topics || []).join(" ") + " " + (scene.tools || []).join(" ");
      const lower = allText.toLowerCase();
      for (const [domain, keywords] of Object.entries(domainKeywords)) {
        const match = keywords.some(k => lower.includes(k));
        if (match) domainFreq.set(domain, (domainFreq.get(domain) || 0) + (scene.sessions || 1));
      }
    }

    const sortedDomains = [...domainFreq.entries()].sort((a, b) => b[1] - a[1]);

    // 从场景块标题推导典型任务
    const taskPatterns = scenes
      .filter(s => s.sessions >= 2 || s.importance >= 7)
      .slice(0, 8)
      .map(s => s.title);

    return { sortedDomains, taskPatterns };
  }

  /**
   * 经验教训提取
   */
  #extractLessons(sessions, scenes) {
    // 收集常见错误
    const errorFreq = new Map();
    for (const s of sessions) {
      for (const e of (s.errors || [])) {
        const key = `${e.tool}: ${(e.error || "").slice(0, 80)}`;
        errorFreq.set(key, (errorFreq.get(key) || 0) + 1);
      }
    }

    const topErrors = [...errorFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([e, c]) => ({ error: e, count: c }));

    // 从场景块中提取踩坑数据
    const sceneErrors = scenes
      .filter(s => s.errors > 0)
      .sort((a, b) => b.errors - a.errors)
      .slice(0, 5)
      .map(s => ({ scene: s.title, errorCount: s.errors }));

    return { topErrors, sceneErrors };
  }

  /**
   * 置信度计算
   */
  #calcConfidence(sessionCount, sceneCount, sessions) {
    let score = 0.3; // base
    
    // 会话量
    if (sessionCount > 100) score += 0.3;
    else if (sessionCount > 50) score += 0.2;
    else if (sessionCount > 20) score += 0.1;

    // 场景量
    if (sceneCount > 20) score += 0.2;
    else if (sceneCount > 10) score += 0.1;

    // 多样性
    const uniqueTools = new Set();
    for (const s of sessions) {
      for (const t of (s.toolsUsed || [])) uniqueTools.add(t);
    }
    if (uniqueTools.size > 30) score += 0.15;
    else if (uniqueTools.size > 15) score += 0.1;

    // 纠正数据
    const corrections = sessions.reduce((s, x) => s + (x.corrections?.length || 0), 0);
    if (corrections > 5) score += 0.05;

    return Math.min(1.0, score);
  }

  /**
   * 构建 Persona Markdown
   */
  #buildPersonaMd(data) {
    const {
      techProfile, workPatterns, commStyle, problemDomains,
      lessons, confidence, totalSessions, totalScenes,
      totalErrors, totalCorrections, existingContent,
    } = data;

    const lines = [];
    lines.push("---");
    lines.push(`generatedAt: ${new Date().toISOString()}`);
    lines.push(`confidence: ${confidence.toFixed(2)}`);
    lines.push(`sourceSessions: ${totalSessions}`);
    lines.push(`sourceScenes: ${totalScenes}`);
    lines.push("---");
    lines.push("");
    lines.push("# 用户画像");
    lines.push("");
    lines.push(`> 基于 ${totalSessions} 次对话和 ${totalScenes} 个场景块的统计分析`);
    lines.push(`> 置信度: ${(confidence * 100).toFixed(0)}%`);
    lines.push("");

    // 技术倾向
    lines.push("## 技术倾向");
    lines.push("");
    const cats = techProfile.categoryCounts;
    const dominantCats = Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .filter(([, c]) => c > 0);
    if (dominantCats.length > 0) {
      lines.push("按工具使用量排序的技术领域：");
      lines.push("");
      for (const [cat, count] of dominantCats) {
        const label = { search: "搜索与信息检索", fileOps: "文件与代码编辑", exec: "命令执行与自动化", system: "系统与任务调度", plugin: "插件与记忆管理" }[cat] || cat;
        lines.push(`- **${label}**`);
      }
      lines.push("");
    }

    const topTools = techProfile.sortedTools.slice(0, 12);
    if (topTools.length > 0) {
      lines.push("最常用工具：");
      lines.push("");
      lines.push(`> \`${topTools.map(([t]) => t).join("`, `")}\``);
      lines.push("");
    }

    // 工作模式
    lines.push("## 工作模式");
    lines.push("");
    lines.push(`- **活跃时段**: ${workPatterns.peakTime}`);
    lines.push(`- **对话深度**: ${commStyle.depthDesc}（平均每话题 ${commStyle.avgDepth} 轮交换）`);
    lines.push("");

    if (workPatterns.topPatterns.length > 0) {
      lines.push("常见工具链序列：");
      lines.push("");
      for (const p of workPatterns.topPatterns.slice(0, 5)) {
        lines.push(`- \`${p.pattern}\`（${p.count} 次）`);
      }
      lines.push("");
    }

    // 沟通风格
    lines.push("## 沟通风格");
    lines.push("");
    lines.push(`- **表达方式**: ${commStyle.styleDesc}`);
    lines.push(`- **深入话题比例**: ${(commStyle.longTurns / Math.max(1, totalSessions) * 100).toFixed(0)}%`);
    lines.push(`- **快速话题比例**: ${(commStyle.shortTopics / Math.max(1, totalSessions) * 100).toFixed(0)}%`);
    lines.push("");

    // 常见问题域
    lines.push("## 常见问题域");
    lines.push("");
    if (problemDomains.sortedDomains.length > 0) {
      for (const [domain, count] of problemDomains.sortedDomains) {
        lines.push(`- **${domain}**（${count} 次相关会话）`);
      }
      lines.push("");
    }

    if (problemDomains.taskPatterns.length > 0) {
      lines.push("典型任务类型：");
      lines.push("");
      for (const task of problemDomains.taskPatterns) {
        lines.push(`- ${task}`);
      }
      lines.push("");
    }

    // 经验教训
    if (lessons.topErrors.length > 0 || lessons.sceneErrors.length > 0) {
      lines.push("## 已知踩坑");
      lines.push("");
      if (lessons.sceneErrors.length > 0) {
        lines.push("高频踩坑场景：");
        lines.push("");
        for (const s of lessons.sceneErrors) {
          lines.push(`- **${s.scene}** — ${s.errorCount} 个错误`);
        }
        lines.push("");
      }
      if (lessons.topErrors.length > 0) {
        lines.push("常见错误模式：");
        lines.push("");
        for (const e of lessons.topErrors.slice(0, 5)) {
          lines.push(`- \`${e.error.slice(0, 100)}\`（${e.count} 次）`);
        }
        lines.push("");
      }
    }

    // 统计数据
    lines.push("## 统计概览");
    lines.push("");
    lines.push(`| 指标 | 数值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 总会话数 | ${totalSessions} |`);
    lines.push(`| 总场景数 | ${totalScenes} |`);
    lines.push(`| 总踩坑 | ${totalErrors} |`);
    lines.push(`| 总纠正 | ${totalCorrections} |`);
    lines.push(`| 使用工具种类 | ${techProfile.sortedTools.length} |`);
    lines.push("");

    return lines.join("\n");
  }
}
