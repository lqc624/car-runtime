# E-6 宿主实连接入指南（M4-S18）

> CAR-as-MCP-Server：宿主（Claude Code / Codex）把 CAR 当作一个 MCP server 接入——
> 9 tool 会话级能力面（session_start/turn/stop/status/replay/verify/export + tool_list/tool_call）。
> 传输 = stdio JSON-RPC（换行分隔），与 M3 契约测试同一接入面（双宿主等价由契约锁定）。

## Claude Code 接入

项目根目录 `.mcp.json`（或 `~/.claude.json` 全局）：

```json
{
  "mcpServers": {
    "car": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "{CAR_ROOT}/src/cli.ts",
        "mcp-serve",
        "--host", "claude-code"
      ]
    }
  }
}
```

## Codex 接入

`~/.codex/config.toml`：

```toml
[mcp_servers.car]
command = "node"
args = [
  "--experimental-transform-types",
  "{CAR_ROOT}/src/cli.ts",
  "mcp-serve",
  "--host", "codex",
]
```

## 验证步骤（E-6 五类契约手工清单）

1. `car doctor` → 确认 Node ≥22.19 与沙箱能力状态；
2. 宿主内触发 MCP 工具列表刷新 → 应看到 9 个 `session_*` / `tool_*` 工具；
3. 调 `session_start` → 返回 `SH-` 前缀会话 id（跨宿主隔离：两个宿主各自 start 得到不同 id）；
4. `session_turn` 提交一批宿主事件 → 返回 `{reason, steps}`；未知宿主事件应无报错（hostRaw 降级留痕，非失败）；
5. `session_verify` → `ok:true`（哈希链完整）；`session_replay` → 消息流与宿主侧对话语义一致；
6. 结束会话后检查 stderr 快照行：`zeroContent=true`（采集窗口零内容红线）。

## 采集窗口（D-2 数据窗口 S18–S20）

- 每次会话结束（stdin 关闭）向 **stderr** 输出一行快照（stdout 为协议通道不可污染）；
- 快照仅含 3 个零内容 Counter（load_total / unsigned_confirmed / registry_decision）——
  `assertZeroContent` 自检内建；
- 登记表兜底：企业未开启遥测时，人工抄录快照行即可满足 S20 enforce 决策的数据输入（双通道设计）。

## E-6 实连执行记录（2026-09-05 · 本机冒烟 ✅）

- 协议握手已实装（initialize / notifications/initialized——MCP 协议兼容，冒烟前置补齐）；
- 本机端到端冒烟（真实 spawn 进程，配置同款命令行）：initialize serverInfo=car-runtime 0.3.0 → tools/list 9 → session_start=SH-fa5c8838469ba4599032d35b → session_turn completed → session_verify ok → stderr 快照 zeroContent=true；
- 宿主侧配置已写入：Claude Code 项目级 `D:/WorkBuddy/agent/.mcp.json` + Codex `~/.codex/config.toml` 追加段（command 用 Node 22.22.2 绝对路径——系统 node20 不支持 --experimental-transform-types）；
- 待真实宿主 GUI 会话验证（启动 Claude Code 于本工作区 / codex 会话内确认 9 tool 出现）。

## 已知边界

- 会话状态为进程内存态（进程退出即失）；跨进程持久化走 `session_export` 取证包 → S19 评估文件落盘增强；
- `tool_list`/`tool_call`（宿主工具面透传）在试点期返回占位（S19 接线宿主侧工具注册）。
