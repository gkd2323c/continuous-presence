/**
 * continuous-presence/lib/pattern-extractor.js
 *
 * 从会话索引中挖掘工作流模式。
 * 分析工具调用序列（原始名+分类名两套），发现反复出现的组合，关联话题和常见错误。
 */
const MIN_PATTERN_SESSIONS = 2;
const MAX_PATTERNS = 30;

// 工具分类：将同类工具归为一组，找更高层次的抽象模式
const TOOL_CATEGORIES = {
  search: [/^web_search/, /^mcp_.*[Ss]earch/, /^mcp_.*[Qq]uery/, /^grep/],
  fetch: [/^web_fetch/, /^mcp_.*[Ee]xtract/, /^mcp_.*[Cc]rawl/, /^mcp_.*[Rr]esearch/],
  read: [/^read$/, /^mcp_.*[Gg]et_/],
  write: [/^write$/, /^edit$/],
  tool_mgmt: [/^install_skill/, /^todo_write/, /^update_settings/],
  file_ops: [/^ls$/, /^find$/, /^bash$/],
  browser: [/^browser/, /^computer/, /^current_status/],
  memory: [/^recall_experience/, /^record_experience/, /^search_memory/, /^pin_memory/, /^unpin_memory/],
  cron: [/^cron/],
  git: [/^mcp_GitHub/, /^git/],
  media: [/^image-gen/, /^mmx/],
};

function categorizeTool(toolName) {
  for (const [cat, patterns] of Object.entries(TOOL_CATEGORIES)) {
    if (patterns.some((p) => p.test(toolName))) return cat;
  }
  return toolName; // 无法归类的保留原名
}

/**
 * @param {object} index - 完整索引（含 sessions）
 * @param {object} log   - logger
 * @returns {{ patterns: object[], errors: object[] }}
 */
export function extractPatterns(index, log) {
  const sessions = index?.sessions;
  if (!sessions || Object.keys(sessions).length === 0) {
    return { patterns: [], errors: [] };
  }

  // 第一步：收集所有 n-gram（同时分析原始名和分类名）
  const rawBigram = new Map();   // "t1||t2" → { count, sessions: Set }
  const rawTrigram = new Map();  // "t1||t2||t3" → { count, sessions: Set }
  const catBigram = new Map();
  const catTrigram = new Map();

  for (const [relPath, session] of Object.entries(sessions)) {
    const seq = session.toolSequence;
    if (!Array.isArray(seq) || seq.length < 2) continue;

    const catSeq = seq.map(categorizeTool);
    const dedup = new Set();

    // ── 原始名 ──
    for (let i = 0; i < seq.length; i++) {
      if (i + 1 < seq.length) {
        const k = `${seq[i]}||${seq[i + 1]}`;
        if (!dedup.has("r2:" + k)) { dedup.add("r2:" + k); inc(rawBigram, k, relPath); }
      }
      if (i + 2 < seq.length) {
        const k = `${seq[i]}||${seq[i + 1]}||${seq[i + 2]}`;
        if (!dedup.has("r3:" + k)) { dedup.add("r3:" + k); inc(rawTrigram, k, relPath); }
      }
    }

    // ── 分类名 ──
    for (let i = 0; i < catSeq.length; i++) {
      if (i + 1 < catSeq.length) {
        const k = `${catSeq[i]}||${catSeq[i + 1]}`;
        if (!dedup.has("c2:" + k)) { dedup.add("c2:" + k); inc(catBigram, k, relPath); }
      }
      if (i + 2 < catSeq.length) {
        const k = `${catSeq[i]}||${catSeq[i + 1]}||${catSeq[i + 2]}`;
        if (!dedup.has("c3:" + k)) { dedup.add("c3:" + k); inc(catTrigram, k, relPath); }
      }
    }
  }

  // 第二步：构建模式列表
  const patterns = [];

  function addPatterns(map, length, isCategorized) {
    for (const [key, { count, sessions: sessionSet }] of map) {
      if (count < MIN_PATTERN_SESSIONS) continue;
      const tools = key.split("||");
      const p = buildPattern(tools, [...sessionSet], sessions, count, length, isCategorized);
      if (p) patterns.push(p);
    }
  }

  addPatterns(rawBigram, 2, false);
  addPatterns(rawTrigram, 3, false);
  addPatterns(catBigram, 2, true);
  addPatterns(catTrigram, 3, true);

  // 第三步：去重——分类名模式如果完全覆盖了原始名模式，保留原始名（更具体）
  const filtered = deduplicatePatterns(patterns);

  // 按得分降序
  filtered.sort((a, b) => b.score - a.score);
  const topPatterns = filtered.slice(0, MAX_PATTERNS);

  // 整理最终格式
  const result = topPatterns.map((p) => ({
    id: `wf-${p.isCategorized ? "cat-" : ""}${p.sequence.join("-")}`,
    sequence: p.sequence,
    length: p.length,
    isCategorized: p.isCategorized,
    frequency: p.frequency,
    sessionCount: p.sessionPaths.length,
    topics: [...p.topics].slice(0, 8),
    errors: [...p.errors].slice(0, 5),
    score: p.score,
  }));

  // 工具 × 错误关联分析
  const toolErrors = analyzeToolErrors(sessions);

  log.info(
    `patterns: ${result.length} found (${Object.keys(sessions).length} sessions)`
  );

  return { patterns: result, errors: toolErrors.slice(0, 15) };
}

// ── 内部函数 ──

function inc(map, key, relPath) {
  if (!map.has(key)) map.set(key, { count: 0, sessions: new Set() });
  const entry = map.get(key);
  entry.count++;
  entry.sessions.add(relPath);
}

function buildPattern(tools, sessionPaths, sessions, rawCount, length, isCategorized) {
  const topics = new Set();
  const errors = new Map();

  for (const relPath of sessionPaths) {
    const s = sessions[relPath];
    if (!s) continue;
    for (const t of s.userTopics || []) { if (t.length > 1) topics.add(t); }
    if (s.title?.length > 1) topics.add(s.title);
    // 错误匹配：分类模式按原始工具名匹配
    for (const err of s.errors || []) {
      const matchTool = isCategorized
        ? tools.some((t) => categorizeTool(err.tool) === t)
        : tools.includes(err.tool);
      if (matchTool) {
        const key = (err.error || "").slice(0, 100);
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
  }

  const score = length * 3 + rawCount * 4 + Math.min(topics.size, 5) * 2 + errors.size * 3;

  return {
    sequence: tools,
    length,
    frequency: rawCount,
    sessionPaths,
    topics,
    errors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e),
    score,
    isCategorized: !!isCategorized,
  };
}

function deduplicatePatterns(patterns) {
  // 如果某个分类名模式包含了原始名模式，且分类名模式覆盖该原始名的所有会话，则移除原始名
  const categorized = patterns.filter((p) => p.isCategorized);
  const raw = patterns.filter((p) => !p.isCategorized);

  const result = [...categorized];
  for (const r of raw) {
    const seqStr = r.sequence.join("||");
    // 检查是否有某个分类名模式完全覆盖这个原始名模式
    const covered = categorized.some((c) => {
      if (r.length > c.length) return false;
      // 检查原始序列的每个工具能否映射到分类序列的对应位置
      for (let i = 0; i <= r.sequence.length; i++) {
        const catSlice = c.sequence.slice(i, i + r.sequence.length);
        if (catSlice.length !== r.sequence.length) continue;
        const match = r.sequence.every((tool, j) => {
          const cat = catSlice[j];
          return tool === cat || categorizeTool(tool) === cat;
        });
        if (match) {
          // 分类模式覆盖所有原始会话
          const rSessions = new Set(r.sessionPaths);
          const cSessions = new Set(c.sessionPaths);
          const allCovered = [...rSessions].every((p) => cSessions.has(p));
          if (allCovered) return true;
        }
      }
      return false;
    });
    if (!covered) result.push(r);
  }

  // 保留 trigram，移除被包含的 bigram（同类比较）
  const trigramRaw = new Set(result.filter((p) => !p.isCategorized && p.length === 3).map((p) => p.sequence.join("||")));
  const trigramCat = new Set(result.filter((p) => p.isCategorized && p.length === 3).map((p) => p.sequence.join("||")));

  return result.filter((p) => {
    if (p.length === 2) {
      const [t1, t2] = p.sequence;
      const set = p.isCategorized ? trigramCat : trigramRaw;
      const contained = [...set].some((tri) => tri.startsWith(`${t1}||${t2}||`) || tri.endsWith(`||${t1}||${t2}`));
      if (contained) return false;
    }
    return true;
  });
}

function analyzeToolErrors(sessions) {
  const toolErrorMap = new Map();
  for (const [, session] of Object.entries(sessions)) {
    for (const err of session.errors || []) {
      const tool = err.tool || "unknown";
      if (!toolErrorMap.has(tool)) toolErrorMap.set(tool, new Map());
      const errMap = toolErrorMap.get(tool);
      const errKey = (err.error || "").slice(0, 80);
      errMap.set(errKey, (errMap.get(errKey) || 0) + 1);
    }
  }
  const result = [];
  for (const [tool, errMap] of toolErrorMap) {
    const top = [...errMap.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) result.push({ tool, error: top[0], count: top[1] });
  }
  result.sort((a, b) => b.count - a.count);
  return result;
}
