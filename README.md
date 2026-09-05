# CAR Runtime（S1 骨架）

Composable Agent Runtime — S1 迭代产物：微内核骨架（F1 可逆注册+依赖注入 / F9 加载-运行两阶段）+ append-only 会话日志层（F2 哈希链 / N1 不变量断言）。

## 运行

```bash
# 测试（零依赖，Node 22.19+ 内置能力）
node --experimental-transform-types --test test/*.spec.ts
```

## 结构

| 路径 | 内容 | 设计依据 |
|------|------|---------|
| `src/kernel/context.ts` | 微内核：plugin/provide/inject/effect + disposeRuntime 双模式卸载（strict-topo 逐层排空 / concurrent 对照） | ADR-002、POC-1 实证 |
| `src/session/log.ts` | append-only 会话日志：SHA-256 哈希链（CAR 自研增强）+ deriveMessages 前缀投影 + assertModelVisibleLogged（N1） | ADR-001、POC-3、dsh invariant.ts 语义 |
| `test/kernel.spec.ts` | 14 项断言（含 strict-topo 层序、异常屏障、依赖环、ctx 作用域） | UserStory US-2/US-7 口径 |
| `src/kernel/events.ts` | F7 事件总线：五模式分发（emit/serial/bail/waterfall/parallel）+ @mode 契约目录（未声明事件禁止注册/分发，启动期 A010003） | dsh typert 范式（源码级核实） |
| `src/loop/stop.ts` | F5 停止语义：step 三结果、TurnEndReason 六值、ADR-001 解析前收口+只读白名单重试、OR/AND 工具收口、取消补记成对事件、F4 权限门集成点 | ADR-001、D4-D5、POC-3 I4 |
| `src/load/loader.ts` | F6 装配：manifest 冲突链校验（精确 semver/豁免 reason 必填）、免编译加载+epoch 热重载、Stub 占位（注册类可用/能力查询 bind 前抛错）+ invalidate | POC-2、冻结决策⑥挂点 |
| `test/s2.spec.ts` | 17 项断言（五模式语义、I4 一致性、解析前收口、取消无缺口、Stub/invalidate、热重载） | US-1/US-5/US-7 口径 |
| `src/sandbox/sandbox.ts` | F3 沙箱执行器：probeCapabilities 能力探测（Linux landlock-run --probe / 其他平台显式降级 BD-01）、降级态 Q-04 约束（写类强制 confirm、env-read 拒绝）、审计全量留痕、landlock-run 包装（--ro/--rw -- argv） | 冻结决策②、Q-04 |
| `src/authz/authz.ts` | F4 授权服务：authorizationId 幂等（T-10）、120s 超时默认拒绝（EXPIRED）、能力标签 deny-by-default（T-22）、决策 100% 落审计日志 | 安全设计 §2.2 |
| `src/mcp/gateway.ts` | F8 MCP 网关：serverId 登记制（A050001）、未声明 sideEffect 注册时收敛 write（T-22 强制点）、BD-02 崩溃隔离（标记不可用不抛异常）、明文凭据 env 拒绝（§3.2.5） | 冻结决策①、US-6 |
| `test/s3.spec.ts` | 14 项断言（探测降级、Q-04 双约束、幂等、超时默认拒绝、BD-02、凭据门、权限一致性无旁路） | US-3/US-6 口径 |

## S1 已实证的设计约束（写码红线）

1. **effect 绑定插件 fiber 作用域**——插件工厂只收 cordis 风格的 apply 作用域 ctx，禁止透传根 ctx（POC-2 实证：错位注册导致卸载回卷不到）；
2. **卸载层序 = 消费者先于提供者**——Kahn 分层方向为 provider→consumer，teardown 必须 reverse（S1 首版即踩）；
3. **apply 返回值 = effect body**（cordis 语义）——CAR 自研内核同步约定：apply 同步完成注册，异步初始化走 effect；
4. **加载期显式失败**——重复 provide/注册、缺服务、依赖环均在 `plugin()`/`disposeRuntime()` 调用点抛出（CAR-E-DEPCYCLE 前缀），禁止静默。

## S2 实测修正的设计口径（写码红线续）

5. **Stub 语义分层**：注册类动作（registerTool/registerCommand）Stub 期**始终可用**（收集待注册项，bindCore 后冲刷）；仅「依赖宿主绑定的能力查询」bind 前抛 CAR-STUB——否则插件挂载即崩；
6. **I4 一致性**：只读白名单重试（Pi 式续走）后 turn/end 仍保留 max-tokens——重试不改变终止原因口径；
7. **AND 收口前置条件**：terminateAll 要求 finalized>0（未执行的调用不计入）；权限拒绝的调用不终止 turn（模型自行调整）；
8. **沙箱测试清理**：rmSync 受 safe-delete trash 拦截会抛错——测试 fixture 清理必须 try/catch 容错。

## S3 实测补充的设计口径（写码红线终）

9. **T-22 强制点在注册时**：MCP 工具未声明 sideEffect 在网关注册时收敛为 write（不做延迟判定）——能力矩阵视图即最终约束视图；
10. **BD-02 隔离语义**：崩溃/超时后 server 整体标记不可用，后续调用返回显式错误结果（不抛异常、不重试、不静默）——调用方落审计日志；
11. **mock 计数陷阱**：tools/list 握手消耗 transport 调用次数，故障注入偏移要算上握手。

| `src/cli.ts` | N2 CLI：car run（五环节快速上手流）/ session verify / session replay / car doctor | US-1/US-4/§6.5 |
| `test/s4.spec.ts` | E2E 五环节全链路 + N2 实测 + Q-06 定标 | 业务闭环端到端 |

| `test/s5.spec.ts` | M2-S5：F10 peer 约束（严格默认/豁免/optional/caret 语义）+ F11 优先级（升序/稳定排序/向后兼容/治理视图） | 冻结决策⑥、F10/F11 AC |
| `adr/ADR-003.md` | 签名双轨定稿（D-1/D-2 裁决实装文档，S6 验签器依据） | 决议⑦ |

| `src/load/verifier.ts` | S6 验签器：minisign 离线轨（ed25519）+ Sigstore 接口预留/回退 + fail-closed 分级（校验失败硬拒绝不可配置 / 缺失 warn→enforce） | ADR-003、D-1/D-2 |
| `src/loop/goal.ts` + `src/loop/recover.ts` | F13 Goal 层（phase 持久化 goalUpdate / activation 纯内存默认 disarmed / 自动 disarm）+ 恢复层（interrupted 补记 + 未配对 toolCall 合成结果） | M2系统设计增补 T-1 |
| `test/s6.spec.ts` | 12 项断言（验签四情形、Goal 重放/幂等恢复、aggregate any/all、blockOnDeny） | D-1/D-2 裁决、US-5 |

| `src/security/secrets.ts` | S7 F12 secrets 检测：6 类模式库 + 三层检测（前缀→熵≥3.5→上下文加成/降级）+ redact 全遮蔽；D-3 标定口径内建（正负 1:9 粗标 FPR 0%/召回 ≥85%） | T-6、D-3 |
| `src/sandbox/sandbox.ts` +2 | S7 Seatbelt profile 生成器（deny default/network*/.git 受保护路径/引号转义）+ darwin 后端接入 | SR-19、dsh darwin 路由 |
| `adr/win32-spike.md` + `scripts/win32-koffi-spike.ts` | S8 Windows spike 方案冻结（三阶段+四判据+逐级回退 a/b/c） | T-3、规划三重闸门① |
| `test/s7.spec.ts` | 13 项断言（检测/脱敏/误报防护/标定粗标/profile 结构/SPIKE SKIP 口径） | F12 AC |

## 状态

| `src/governance/dump.ts` | S9 F14 治理视图：配置树 dump（Context.governanceSnapshot）+ 事件产消图（目录 × handlerChain 按 priority 执行序） | P1-7 |
| `src/session/export.ts` | S9 F15 合规导出增强：取证包（逐文件 SHA-256 + 链锚点 + 审计元数据，断链中止）+ verifyBundle + 三标分层声明（9 核心字段三标全覆盖 + 标准特有扩展） | Q-09、决议⑧、T-7 |
| `adr/mlps-audit-checklist.md` | 等保 8.1.4.3 a–d 逐条核验（三独立来源交叉证实）：a/b 满足、c/d 部分满足差距显式标注（MLPS-G1/G2/G3 处置） | D-4 |
| `test/s9.spec.ts` | 5 项断言（配置树/产消图/取证包/篡改拒绝/三标分层） | F14/F15/D-4 |

| `src/host/mappings.ts` | S11 T-1 归一化 schema（host-mappings-v1）：session id 确定性派生（SH-+sha256）+ 两宿主纯数据 profile + hostRaw 零静默降级通道 | 决议⑤、T-1 |
| `src/host/hostGateway.ts` | S11 HostGateway 骨架：9 tool 会话级能力面（step 循环不暴露）+ hostId 登记制（A050001）+ RuntimeFacade 分发（snake→camel）+ 审计全留痕 | M3系统设计增补 T-1 |
| `test/s11.spec.ts` | 10 项断言（幂等派生/跨宿主隔离/归一化等价/降级留痕/登记制/9 tool 面/契约测试 v0/宿主标识静态断言） | 双宿主等价基线 |

## 状态

| `src/host/stdio.ts` | S12 stdio ServerTransport：JSON-RPC over 换行分隔 JSON（tools/list + tools/call 分发），非法 JSON/未知 method 显式报错不崩溃 | 多宿主主形态（部署增补 §4） |
| `src/host/facade.ts` | S12 RuntimeFacade 真实实现：sessionStart 幂等建会话+登记事件落哈希链；sessionTurn 事件批归一化落盘（hostRaw 零静默）；replay/verify/export 全通 | T-1 数据流 |
| `test/s12.spec.ts` | 5 项断言（stdio 双方法+容错/端到端落链+离线重放/跨宿主投影等价/审计无旁路） | 双宿主等价核心 |

## 状态

| `src/load/registry.ts` | S13 registry 配置面：resolution 四级顺序（显式绑定硬失败不降级→白名单 priority→npm 兜底可关→离线全拒）+ 白名单即清单本身 + 决策指纹 RD-* 可落审计 | 决议⑦、T-3/T-4 |
| `test/s13.spec.ts` | 7 项断言（四级顺序/显式绑定硬失败/兜底可关/离线最高/审计全量/五类契约全链路等价/降级同步+会话隔离） | 契约测试 v1 |

## 状态

| `src/ptc/` | S14 PTC I：budget（三层收敛只许下调 CAR-E-BUDGET）+ erasable 双挂点（入口+loader）+ worker-entry（async 函数体/tools proxy 消息桥/wallTimer）+ runCode（code+description 双必填、并发护栏 4、双层预算、makePtcToolDefinition 强制 write） | 决议③、T-2 |

## 状态

| `src/ptc/sdk.ts` | S15 TS SDK 渲染：注册表快照→system prompt TS 声明（非 .d.ts）；声明面/授权面结构一致性（渲染只接受注册表自身，漂移在结构上不可能） | T-2、dsh :26,97 口径 |
| `src/ptc/runCode.ts` +2 | S15 授权门前置（拒绝=无 worker 启动+ptc-denied 留痕，authorizationId='ptc-'+id 幂等）+ F12 出站覆盖（worker 输出回填前强制 redact，secretsRedacted 计数） | T-4、决议③红线 |

## 状态

| `src/load/registry.ts` +2 | S17 T-5 终局对齐实装：exclude 通道（类型上仅 reason='network'——校验失败换源不可表达）+ 候选耗尽语义修正 + resolveCandidateChain 预览 + pinned 网络失败按 priority 继续 | M4安全增补registry对齐 |
| `src/telemetry/metrics.ts` | S17 采集面：3 个零内容 Counter（load_total/unsigned_confirmed/registry_decision）+ snapshot 登记表兜底通道 + assertZeroContent 红线自检 | Q-08、D-2 数据窗口前置 |
| `test/s17.spec.ts` | 9 项断言（exclude 三路径/耗尽 fail-closed/候选链预览/零内容红线/verifier 采集挂点） | T-5 定稿② |

## 状态

| `src/cli.ts mcp-serve` | S18 CAR-as-MCP-Server 真实进程入口：--host 数据驱动白名单 + counters 挂载 + 会话结束 stderr 零内容快照（stdout 协议通道不污染） | E-6 实连前置 |
| `adr/host-onboarding.md` | 宿主接入指南：Claude Code .mcp.json / Codex config.toml 配置片段 + 五类契约手工验证清单 + 采集窗口说明 | E-6 |
| `test/s18.spec.ts` | 4 项断言（**spawn 真实子进程** stdio 全链路/跨进程幂等派生/采集快照/未知宿主 exit 2） | E-6 进程级预演 |

## 状态

| `scripts/ptc-baseline/` | S19 T-7 评测脚本实装：12 任务五类 + 逐任务 N 次对照（非 PTC 基线）+ JSONL 明细/汇总——**首份实测：PTC 60/60=100% ≥ 非 PTC 100%，P1-4 ✅** | PRD P1-4 |

## 状态

- S1-S4：48/48 ✅ ｜ M2：89/89（v0.2.0）｜ M3：127/127（v0.3.0）｜ M4：S17→S18→**S19 139/139 + T-5 归档（勾稽 7/7）+ P1-4 首份实测 ✅**
- M4 待办：S19 Codex 实连（宿主侧配置就绪，真进程接入待试点环境）+ registry 增补评审（T-5 归档门）；S20 enforce 决策（采集窗口 S18 已开启）+ PTC 评测脚本；轨道 A（你）：E-1/E-2/E-3。
- M4 待办：S18 Claude Code 实连 + 采集窗口开启（采集面已就位）；S19 Codex 实连 + registry 增补评审；S20 enforce 决策 + PTC 评测（脚本 2 人日待实装）；轨道 A（你）：E-1/E-2/E-3 沙箱外。
- 环境动作清单（E-1~E-4 + E-6 宿主实连试点）与遗留移交见 delivery/M3收口终验报告.md；M4 预埋：fork 跨宿主/深度参数渲染/定时导出。
- **内核行为修复（S14 捕获）**：工具异常原会终止 turn（reason=error）——已修为「成对错误 toolResult 交回模型」（US-5/D5 语义：工具错误是结果而非 turn 中断），121 断言零回退。
- 环境动作清单（E-1~E-5）与遗留移交（T-8 等）见 delivery/M2收口终验报告.md；G-03 豁免机制：secrets 规则库/标定基准显式列文件豁免，清单变更需评审。
- M2 待办：S6 验签器实装（ADR-003）+ F13 五层停止（M2系统设计增补 T-1）；S7/S8 跨平台沙箱（Windows koffi spike）；S9 治理+导出；S10 收口。
- **N2 实测**：首插件跑通 3ms（目标 ≤300s，余量 10 万倍）
- **Q-06 定标回填**：装配 20 插件 <1ms；serial 分发 1000 次 6ms；日志 1 万事件追加+哈希链 125ms、回放+校验 21ms
- 待办：jiti 实装补测首载时延（载体替身已验证不变量）；POC-4 Linux/WSL2 实跑；发布工程预演（dist-tag beta）
