/**
 * continuous-presence/index.js
 *
 * 后台常驻：扫描会话 → 构建索引 → 对外提供工具。
 * 不主动注入任何上下文，只被动查询。
 */
import path from "node:path";
import { createScanner } from "./lib/session-scanner.js";
import { extractPatterns } from "./lib/pattern-extractor.js";

export default class ContinuousPresencePlugin {
  /** @type {import("./lib/session-scanner.js").SessionScanner | null} */
  #scanner = null;
  #scanTimer = null;
  #log = null;

  async onload() {
    this.#log = this.ctx.log;

    const { dataDir, bus } = this.ctx;
    const agentsDir = path.resolve(dataDir, "..", "..", "agents");

    this.#log.info(`continuous-presence loading`);
    this.#log.info(`  dataDir: ${dataDir}`);
    this.#log.info(`  agentsDir: ${agentsDir}`);

    // 创建扫描器并执行初始全量扫描
    this.#scanner = await createScanner({
      agentsDir,
      agentId: "hanako",
      indexDir: dataDir,
      log: this.#log,
    });

    await this.#scanner.scan();
    await this.#runPatternExtraction();
    this.#log.info("initial scan complete");

    // 每 15 分钟增量扫描一次
    this.#scanTimer = setInterval(() => {
      this.#scanner?.scanIncremental().catch((err) => {
        this.#log.error("incremental scan failed:", err);
      });
    }, 15 * 60 * 1000);

    // 注册 bus handler：其他插件或工具可以请求强制重新扫描
    this.register(
      bus.handle("continuous-presence:scan", async () => {
        await this.#scanner.scan();
        await this.#runPatternExtraction();
        return { ok: true };
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
          lines.push(`  摘要：${session.summary || "(无文本)"}`);
          lines.push(`  相关度：${score}`);
          lines.push("");
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

    // 工具注册返回的清理函数也注册到生命周期
    this.register(unreg);
    this.register(unreg2);

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

  async onunload() {
    // this.register() 注册的资源自动清理
    // 只需清理框架管不到的：
    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
    this.#scanner = null;
    this.#log.info("continuous-presence unloaded");
  }
}
