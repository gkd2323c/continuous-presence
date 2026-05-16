/**
 * continuous-presence/index.js
 *
 * 后台常驻：扫描会话 → 构建索引 → 对外提供工具。
 * 不主动注入任何上下文，只被动查询。
 */
import path from "node:path";
import { createScanner } from "./lib/session-scanner.js";
import { extractPatterns } from "./lib/pattern-extractor.js";
import { createSceneBuilder } from "./lib/scene-builder.js";
import { createNodeResolver, parseNodeId } from "./lib/node-resolver.js";

export default class ContinuousPresencePlugin {
  /** @type {import("./lib/session-scanner.js").SessionScanner | null} */
  #scanner = null;
  /** @type {import("./lib/scene-builder.js").SceneBuilder | null} */
  #sceneBuilder = null;
  /** @type {import("./lib/node-resolver.js").NodeResolver | null} */
  #nodeResolver = null;
  #scanTimer = null;
  #sceneUpdateTimer = null;
  #log = null;

  async onload() {
    this.#log = this.ctx.log;

    const { dataDir, bus } = this.ctx;
    const agentsDir = path.resolve(dataDir, "..", "..", "agents");
    const sceneDir = path.join(dataDir, "scene_blocks");

    this.#log.info(`continuous-presence loading`);
    this.#log.info(`  dataDir: ${dataDir}`);
    this.#log.info(`  agentsDir: ${agentsDir}`);
    this.#log.info(`  sceneDir: ${sceneDir}`);

    // 创建扫描器
    this.#scanner = await createScanner({
      agentsDir,
      agentId: "hanako",
      indexDir: dataDir,
      log: this.#log,
    });

    // 创建场景块构建器
    this.#sceneBuilder = await createSceneBuilder({
      sceneDir,
      log: this.#log,
    });

    // 创建 node_id 解析器
    const sessionsDir = path.resolve(agentsDir, "hanako", "sessions");
    this.#nodeResolver = createNodeResolver({
      sessionsDir,
      log: this.#log,
    });

    // 初始全量扫描 + 场景构建
    await this.#scanner.scan();
    await this.#runPatternExtraction();
    await this.#rebuildScenes();
    this.#log.info("initial scan + scene build complete");

    // 每 15 分钟增量扫描一次
    this.#scanTimer = setInterval(() => {
      this.#scanner?.scanIncremental().catch((err) => {
        this.#log.error("incremental scan failed:", err);
      });
    }, 15 * 60 * 1000);

    // 每 60 分钟增量更新场景块（场景更新频率低于扫描）
    this.#sceneUpdateTimer = setInterval(() => {
      this.#rebuildScenes().catch((err) => {
        this.#log.error("scene rebuild failed:", err);
      });
    }, 60 * 60 * 1000);

    // 注册 bus handler
    this.register(
      bus.handle("continuous-presence:scan", async () => {
        await this.#scanner.scan();
        await this.#runPatternExtraction();
        await this.#rebuildScenes();
        return { ok: true };
      })
    );

    // 注册场景重建 handler
    this.register(
      bus.handle("continuous-presence:rebuild-scenes", async () => {
        await this.#rebuildScenes();
        return { ok: true, scenes: this.#sceneBuilder?.listScenes().length || 0 };
      })
    );

    // 注册清理函数
    this.register(() => {
      if (this.#scanTimer) {
        clearInterval(this.#scanTimer);
        this.#scanTimer = null;
      }
      this.#scanner = null;
    });

    // 动态注册 recall-context 工具
    // 注意：tools/ 目录下静态注册的工具优先级更高，
    // 但动态注册可以让工具访问 #scanner 实例
    const unreg = this.ctx.registerTool({
      name: "recall-context",
      description:
        "查询我过去的对话经验。当我感觉「之前遇到过类似问题」但又记不清时调用，或者你主动问「你之前处理过 XXX 吗」时使用。返回与查询相关度最高的历史会话摘要。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "查询内容，如「代理配置」「B站视频」「MCP 服务器」",
          },
          maxResults: {
            type: "number",
            description: "最大返回条数（默认 5）",
          },
          days: {
            type: "number",
            description: "限定查询最近多少天内的会话（不填则查全部）",
          },
        },
        required: ["query"],
      },
      execute: async (input, toolCtx) => {
        const index = this.#scanner?.getIndex();
        if (!index || !index.sessions || Object.keys(index.sessions).length === 0) {
          return { content: [{ type: "text", text: "历史会话索引还未建立，请稍后再试。" }] };
        }

        const query = (input.query || "").toLowerCase();
        const maxResults = Math.min(input.maxResults || 5, 20);
        const days = input.days ? parseInt(input.days, 10) : null;

        const cutoff = days ? Date.now() - days * 86400000 : 0;

        // 打分：标题匹配 + 话题匹配 + 工具匹配 + 文本匹配
        const scored = [];

        for (const [relPath, session] of Object.entries(index.sessions)) {
          // 时间过滤
          const ts = session.timestamp ? new Date(session.timestamp).getTime() : 0;
          if (cutoff && ts < cutoff) continue;

          let score = 0;
          const qWords = query.split(/\s+/).filter(Boolean);

          for (const qw of qWords) {
            // 标题匹配（权重高）
            if ((session.title || "").toLowerCase().includes(qw)) score += 5;
            // 话题匹配
            if ((session.userTopics || []).some((t) => t.toLowerCase().includes(qw))) score += 3;
            // 工具匹配
            if ((session.toolsUsed || []).some((t) => t.toLowerCase().includes(qw))) score += 2;
            // 摘要匹配
            if ((session.summary || "").toLowerCase().includes(qw)) score += 4;
            // 错误匹配
            if ((session.errors || []).some((e) => (e.error || "").toLowerCase().includes(qw))) score += 3;
          }

          if (score > 0) {
            scored.push({ relPath, session, score });
          }
        }

        // 按得分降序
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, maxResults);

        if (top.length === 0) {
          return { content: [{ type: "text", text: `没有找到与「${input.query}」相关的历史会话。` }] };
        }

        // 格式化输出
        const lines = [];
        lines.push(`找到 ${top.length} 条相关历史经验：\n`);

        for (const { relPath, session, score } of top) {
          const date = session.timestamp
            ? new Date(session.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
            : "未知时间";
          const title = session.title || "(无标题)";
          const topicStr = session.userTopics?.length
            ? `话题：${session.userTopics.join("、")}`
            : "";

          lines.push(`【${title}】`);
          lines.push(`  时间：${date}`);
          if (topicStr) lines.push(`  ${topicStr}`);
          lines.push(`  对话轮次：${session.exchangeCount || 0}`);
          if (session.toolsUsed?.length) {
            lines.push(`  使用工具：${session.toolsUsed.join(", ")}`);
          }
          if (session.errors?.length) {
            lines.push(`  踩坑 ${session.errors.length} 个`);
            // 显示第一个错误摘要
            const firstErr = session.errors[0];
            lines.push(`  例如：${firstErr.tool} → ${firstErr.error.slice(0, 120)}`);
          }
          if (session.corrections?.length) {
            lines.push(`  被纠正 ${session.corrections.length} 次`);
          }
          // 添加 node_id 可追溯引用
          const sessionId = extractSessionIdFromPathSimple(relPath);
          if (sessionId) {
            lines.push(`  追溯：\`node:${sessionId}:first-msg\`（复制后用 resolve-node 查看原文）`);
          }
          lines.push(`  摘要：${session.summary || "(无文本)"}`);
          lines.push(`  相关度：${score}`);
          lines.push("");
        }

        // 查找相关的场景块（L2）
        const scenes = this.#sceneBuilder?.listScenes() || [];
        if (scenes.length > 0) {
          const queryWords = (input.query || "").toLowerCase().split(/\s+/).filter(Boolean);
          const matchedScenes = scenes
            .filter(s => {
              if (s.archived) return false;
              const topicStr = (s.topics || []).join(" ").toLowerCase();
              const titleStr = (s.title || "").toLowerCase();
              return queryWords.some(qw => topicStr.includes(qw) || titleStr.includes(qw));
            })
            .slice(0, 3);

          if (matchedScenes.length > 0) {
            lines.push(`📂 相关场景块（${matchedScenes.length} 个）：\n`);
            for (const s of matchedScenes) {
              lines.push(`  ${s.title}`);
              lines.push(`    话题：${(s.topics || []).slice(0, 6).join("、")}`);
              lines.push(`    重要性：${s.importance} | 涉及 ${s.sessions} 次会话`);
              if (s.tools?.length) {
                lines.push(`    常用工具：${s.tools.slice(0, 6).join(", ")}`);
              }
              lines.push("");
            }
          }
        }

        // 查找相关的工作流模式
        const idx = this.#scanner?.getIndex();
        if (idx?.patterns?.length) {
          const queryWords = (input.query || "").toLowerCase().split(/\s+/).filter(Boolean);
          const matchedPatterns = idx.patterns.filter((p) => {
            if (!p.sequence?.length) return false;
            const seqStr = p.sequence.join(" ").toLowerCase();
            const topicStr = (p.topics || []).join(" ").toLowerCase();
            return queryWords.some((qw) => seqStr.includes(qw) || topicStr.includes(qw));
          });

          if (matchedPatterns.length > 0) {
            lines.push(`📋 相关工作流模式（${matchedPatterns.length} 个）：\n`);
            for (const p of matchedPatterns.slice(0, 3)) {
              lines.push(`  ${p.sequence.join(" → ")}`);
              lines.push(`    出现在 ${p.sessionCount} 次会话中，涉及：${(p.topics || []).slice(0, 4).join("、")}`);
              if (p.errors?.length) {
                lines.push(`    常见错误：${p.errors[0].slice(0, 80)}`);
              }
              lines.push("");
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    });

    // 注册第二个工具：会话概览
    const unreg2 = this.ctx.registerTool({
      name: "session-summary",
      description:
        "查看最近一段时间的历史会话概览。支持按天和按话题聚合。适合用来快速回顾最近做了什么。",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            description: "时间范围：today / week / month / all（默认 today）",
            enum: ["today", "week", "month", "all"],
          },
          minScore: {
            type: "number",
            description: "最低相关度过滤（1-10，默认不限制）",
          },
        },
      },
      execute: async (input, toolCtx) => {
        const index = this.#scanner?.getIndex();
        if (!index || !index.sessions || Object.keys(index.sessions).length === 0) {
          return { content: [{ type: "text", text: "历史会话索引还未建立。" }] };
        }

        const period = input.period || "today";
        const minScore = input.minScore || 0;

        const now = Date.now();
        const periodMs = {
          today: 86400000,
          week: 7 * 86400000,
          month: 30 * 86400000,
          all: Infinity,
        };
        const limit = periodMs[period] || 86400000;

        // 过滤并排序
        const matched = Object.entries(index.sessions)
          .filter(([, s]) => {
            const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
            return now - ts <= limit;
          })
          .sort(([, a], [, b]) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return tb - ta; // 最新优先
          });

        if (matched.length === 0) {
          return { content: [{ type: "text", text: `最近 ${period} 内没有历史会话。` }] };
        }

        // 统计
        const totalExchanges = matched.reduce((sum, [, s]) => sum + (s.exchangeCount || 0), 0);
        const totalErrors = matched.reduce((sum, [, s]) => sum + (s.errors?.length || 0), 0);
        const allTools = new Set();
        matched.forEach(([, s]) => (s.toolsUsed || []).forEach((t) => allTools.add(t)));
        const topTopics = new Map();
        matched.forEach(([, s]) =>
          (s.userTopics || []).forEach((t) =>
            topTopics.set(t, (topTopics.get(t) || 0) + 1)
          )
        );

        const lines = [];
        lines.push(`📊 ${period === "today" ? "今日" : period === "week" ? "本周" : period === "month" ? "本月" : "全部"}会话概览`);
        lines.push(`  会话数量：${matched.length}`);
        lines.push(`  总对话轮次：${totalExchanges}`);
        lines.push(`  踩坑次数：${totalErrors}`);
        lines.push(`  使用过 ${allTools.size} 种工具：${[...allTools].join(", ") }`);

        if (topTopics.size > 0) {
          const sorted = [...topTopics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
          lines.push(`  热门话题：`);
          for (const [topic, count] of sorted) {
            lines.push(`    ${topic}（${count}次）`);
          }
        }

        lines.push("");
        lines.push(`会话列表（最新优先）：`);

        for (const [relPath, s] of matched.slice(0, 20)) {
          const date = s.timestamp
            ? new Date(s.timestamp).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "?";
          const title = s.title || "(无标题)";
          const errTag = s.errors?.length ? ` ⚠${s.errors.length}` : "";
          lines.push(`  ${date}  ${title}${errTag}`);
        }

        if (matched.length > 20) {
          lines.push(`  ... 还有 ${matched.length - 20} 条`);
        }

        // 显示工作流模式
        const idx = this.#scanner?.getIndex();
        if (idx?.patterns?.length) {
          const topPatterns = idx.patterns.slice(0, 5);
          lines.push("");
          lines.push(`📋 常见工作流模式（Top ${topPatterns.length}）：`);
          for (const p of topPatterns) {
            lines.push(`  ${p.sequence.join(" → ")}`);
            lines.push(`    ${p.sessionCount} 次会话 | 得分 ${p.score}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    });

    // 注册第三个工具：场景块查询
    const unreg3 = this.ctx.registerTool({
      name: "scene-search",
      description:
        "查询场景块（Scene Blocks）——主题化的经验聚合。每个场景块是一组相关会话围绕同一话题的提炼，" +
        "包含关键知识点、工具使用模式和常见踩坑。适合想了解某个话题的全貌而非单次会话时使用。" +
        "返回匹配的场景块摘要。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "查询内容，如「Nginx」「MCP」「B站视频总结」",
          },
          maxResults: {
            type: "number",
            description: "最大返回条数（默认 5）",
          },
          minImportance: {
            type: "number",
            description: "最低重要性过滤（1-10，默认不限制）",
          },
          includeContent: {
            type: "boolean",
            description: "是否返回场景块完整 Markdown 内容（默认 false，只返回摘要）",
          },
        },
        required: ["query"],
      },
      execute: async (input, toolCtx) => {
        const scenes = this.#sceneBuilder?.listScenes() || [];
        if (scenes.length === 0) {
          return { content: [{ type: "text", text: "场景块索引还未建立。" }] };
        }

        const query = (input.query || "").toLowerCase();
        const maxResults = Math.min(input.maxResults || 5, 20);
        const minImportance = input.minImportance || 0;
        const includeContent = input.includeContent === true;

        const queryWords = query.split(/\s+/).filter(Boolean);

        // 打分
        const scored = [];
        for (const scene of scenes) {
          if (scene.archived) continue;
          if (scene.importance < minImportance) continue;

          let score = 0;
          for (const qw of queryWords) {
            if ((scene.title || "").toLowerCase().includes(qw)) score += 5;
            if ((scene.topics || []).some(t => t.toLowerCase().includes(qw))) score += 4;
            if ((scene.tools || []).some(t => t.toLowerCase().includes(qw))) score += 2;
          }
          if (score > 0) scored.push({ scene, score });
        }

        scored.sort((a, b) => b.score - a.score || b.scene.importance - a.scene.importance);
        const top = scored.slice(0, maxResults);

        if (top.length === 0) {
          return { content: [{ type: "text", text: `没有找到与「${input.query}」相关的场景块。` }] };
        }

        const lines = [];
        lines.push(`找到 ${top.length} 个相关场景块：\n`);

        for (const { scene, score } of top) {
          lines.push(`📂 ${scene.title}（重要性 ${scene.importance}）`);
          lines.push(`  话题：${(scene.topics || []).slice(0, 8).join("、")}`);
          lines.push(`  涉及 ${scene.sessions} 次会话，${scene.exchanges || 0} 轮对话`);
          if (scene.tools?.length) {
            lines.push(`  工具：${scene.tools.slice(0, 8).join(", ")}`);
          }
          if (scene.errors > 0) {
            lines.push(`  记录 ${scene.errors} 个踩坑`);
          }
          lines.push(`  匹配度：${score}`);

          if (includeContent) {
            const content = await this.#sceneBuilder.getSceneContent(scene.id);
            if (content) {
              lines.push("");
              lines.push(content.split("\n").slice(12, 40).join("\n")); // 跳过 frontmatter
              lines.push("");
            }
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    });

    // 注册第四个工具：node_id 解析
    const unreg4 = this.ctx.registerTool({
      name: "resolve-node",
      description:
        "通过 node_id 追溯消息原文。每条消息有一个唯一 node_id（格式：{sessionId}:{messageId}），" +
        "输入 node_id 即可查看该条消息的原文内容。" +
        "场景块和回忆结果中会标注可追溯的 node_id。",
      parameters: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "node_id，格式为 {sessionId}:{messageId}，如 019e00cc-4786-726d-a126-d67721cfc818:504c4d9f",
          },
          contextLines: {
            type: "number",
            description: "返回的前后文消息条数（默认 0）",
          },
        },
        required: ["nodeId"],
      },
      execute: async (input, toolCtx) => {
        const resolver = this.#nodeResolver;
        if (!resolver) {
          return { content: [{ type: "text", text: "节点解析器还未就绪。" }] };
        }

        const nodeId = (input.nodeId || "").trim();
        if (!nodeId) {
          return { content: [{ type: "text", text: "请提供 node_id。" }] };
        }

        // 支持简写: 如果 nodeId 不含 :，尝试定位
        const parsed = parseNodeId(nodeId);
        if (!parsed) {
          return { content: [{ type: "text", text: `无效的 node_id 格式：${nodeId}。应为 {sessionId}:{messageId}。` }] };
        }

        const ctxLines = Math.min(Math.max(0, input.contextLines || 0), 10);
        const result = await resolver.resolve(nodeId, { contextLines: ctxLines });

        if (!result) {
          return { content: [{ type: "text", text: `未找到 node_id 对应的消息：${nodeId}。` }] };
        }

        const lines = [];
        lines.push(`📎 node_id: ${result.nodeId}`);
        lines.push(`角色: ${result.role === "user" ? "👤 用户" : "🤖 Assistant"}`);
        lines.push(`时间: ${result.timestamp || "未知"}`);
        lines.push("");

        if (result.prev?.length) {
          lines.push(`← 前文（${result.prev.length} 条）：`);
          for (const p of result.prev) {
            const snippet = p.slice(0, 200).replace(/\n/g, " ");
            lines.push(`  ${snippet}`);
          }
          lines.push("");
        }

        lines.push("原文：");
        lines.push(result.text || "(无文本)");
        lines.push("");

        if (result.next?.length) {
          lines.push(`→ 后文（${result.next.length} 条）：`);
          for (const n of result.next) {
            const snippet = n.slice(0, 200).replace(/\n/g, " ");
            lines.push(`  ${snippet}`);
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    });

    // 工具注册返回的清理函数也注册到生命周期
    this.register(unreg);
    this.register(unreg2);
    this.register(unreg3);
    this.register(unreg4);

    this.#log.info("continuous-presence ready");
  }

  /** 扫描完成后运行模式提取，将结果写入索引并持久化 */
  async #runPatternExtraction() {
    const index = this.#scanner?.getIndex();
    if (!index) return;

    const { patterns, errors: toolErrors } = extractPatterns(index, this.#log);
    index.patterns = patterns;
    index.toolErrors = toolErrors;

    // 持久化
    try {
      const { writeFileSync } = await import("node:fs");
      const indexFile = path.join(this.ctx.dataDir, "index.json");
      writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
    } catch (err) {
      this.#log.error("failed to persist patterns:", err);
    }
  }

  /** 从当前索引重建所有场景块 */
  async #rebuildScenes() {
    const index = this.#scanner?.getIndex();
    if (!index || !this.#sceneBuilder) return;
    await this.#sceneBuilder.updateFromSessionIndex(index, 30);
  }

  async onunload() {
    // this.register() 注册的资源自动清理
    // 只需清理框架管不到的：
    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
    if (this.#sceneUpdateTimer) {
      clearInterval(this.#sceneUpdateTimer);
      this.#sceneUpdateTimer = null;
    }
    this.#scanner = null;
    this.#sceneBuilder = null;
    this.#nodeResolver = null;
    this.#log.info("continuous-presence unloaded");
  }
}

/**
 * 从会话文件路径中提取 session_id（用于 recall-context 的 node_id 追溯）
 */
function extractSessionIdFromPathSimple(filePath) {
  const base = filePath.replace(/\.jsonl$/i, "").split(/[\\\/]/).pop() || "";
  if (!base) return null;
  const parts = base.split("_");
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)) {
      return p;
    }
  }
  return parts.length > 1 ? parts.slice(1).join("_") : parts[0] || null;
}
