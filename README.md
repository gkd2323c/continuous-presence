# Continuous Presence

让 Hanako 拥有「持续存在感」——在后台扫描历史会话，构建可检索的经验索引，在对话中主动回想过去处理过类似问题时的经验和教训。

## 原理

直接读取 Hanako 本地保存的 `.jsonl` 会话文件（`~/.hanako/agents/hanako/sessions/`），解析每轮对话的结构化数据：

- 提取话题、使用的工具、踩坑记录
- 标记用户纠正过的内容
- 构建轻量本地索引（`plugin-data/continuous-presence/index.json`）

## 提供的工具

| 工具 | 说明 |
|---|---|
| `continuous-presence_recall-context` | 查询过去对话经验。输入话题，返回相关历史会话及其摘要、工具使用、踩坑记录 |
| `continuous-presence_session-summary` | 查看今日/本周/本月会话概览，包含统计数据和会话列表 |

## 安装

1. 将 `continuous-presence/` 整个文件夹放入 `~/.hanako/plugins/`
2. 在设置 → 插件中开启「允许全插件访问」
3. 重启 Hanako

## 权限说明

本插件需要 `full-access` 权限，因为：
- 使用 `index.js` 生命周期，后台常驻扫描会话文件
- 使用 `bus.handle()` 注册事件处理器
- 使用 `registerTool()` 动态注册工具

## 数据安全

- **所有数据本地处理**，不发送任何网络请求
- 只读取会话文件的元数据（话题、工具名、错误记录），不存储对话原文
- 索引文件位于 `plugin-data/continuous-presence/index.json`，属于你的私人数据
- 插件本身不包含任何个人信息，可放心开源

## 许可证

MIT
