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
| `src/host/hostGateway.ts` | S11 HostGateway 骨架：10 tool 会话级能力面（step 循环不暴露）+ hostId 登记制（A050001）+ RuntimeFacade 分发（snake→camel）+ 审计全留痕 | M3系统设计增补 T-1 |
| `test/s11.spec.ts` | 10 项断言（幂等派生/跨宿主隔离/归一化等价/降级留痕/登记制/10 tool 面/契约测试 v0/宿主标识静态断言） | 双宿主等价基线 |

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

| `src/ptc/schemaRender.ts` | M5 DEC-4①：JSON Schema→TS 深度参数渲染（const/enum 字面量、嵌套 object required/optional、数组/元组 prefixItems、additionalProperties、anyOf/oneOf/allOf；$ref/not/畸形/超深 fail-visible 落 unknown 带原因） | M3-S16 评估项转正 |
| `src/session/fork.ts` | M5 DEC-4②：跨宿主 fork/resume——链逐字节迁移 + fork 标记落链（fromSessionId/target/upToSeq）+ 目标会话 id 确定性派生 + 断链拒绝 + 归属校验 + #tail 恢复续跑 | M3 §1.7 延后项转正 |
| `test/s16.spec.ts` + `test/s19.spec.ts` | M5 断言：s16 深渲 10 项 + s19 fork 7 项（含双宿主 facade E2E） | 全量 156/156 |

| `src/load/report.ts` + `src/dx/doctor.ts` | M6 DX 工具链：loadPlugins 五阶段编排（discover→parse→validate→topo→register，FAIL 短路 SKIPPED）+ LoadReportVO/renderLoadReport（§3.2.M6.3 逐字对齐）+ ReloadManager（epoch+1 击穿缓存 → invalidate 旧实例 → 重装配，FAIL 不静默回退）+ doctor 凭据/连通性（值不打印、离线 SKIPPED 不失败） | §3.2.M6、QS-05 |
| `src/cli.ts` +2 | M6：car reload <file\|dir>（五阶段报告 + 退出码 0/1/2）+ doctor 增强（凭据/连通性） | §3.2.M6.2 |
| `docs/plugin-authoring.md` | 插件作者指南：文件形态 + 四条红线（fiber 作用域 invalidate / apply disposer / CAR-STUB 分层 / CAR-INVALIDATED）+ 五阶段表 | POC-2 红线 |
| `test/s20.spec.ts` + `test/s21.spec.ts` | M6 测试：10 + 13 个 test（五阶段/短路/冲突链/热重载/并发 reload 不变量/doctor 离线/QS-05 P95 最近邻秩） | §3.2.M6 AC |

| `src/session/store.ts` + `src/session/format.ts` | M7 存储层+格式层：SessionFileStore（O_APPEND 单 write 行级原子 + fsyncSync，sink throw = fail-fast 事件不入内存）+ 撕裂尾显式格式校验（崩溃半行显式丢弃报告，与 CAR-E-FORMAT/断链三语义互斥）+ zstd 能力探测 codec（magic 嗅探 layout-blind 直读，缺席显式 CAR-E-ZSTD；实测压缩比 6.21x ≥ 3x 规格口径） | §3.2.M7.1 第 4 点、§3.2.M7.5 |
| `src/session/indexStore.ts` | M7 C-02 SQLite 会话索引：node:sqlite 动态探测（静态 import 会崩模块加载）+ 单事务幂等重建（DELETE+INSERT）+ 断链/坏格式文件入 errors 不中断（索引只收链完整会话） | §3.2.M7.2 索引行、§3.2.M7.5 Step 3 |
| `src/cli.ts` session 扩展 + `src/session/log.ts` | M7：car session export（SQ-06 全流程：断链中止 + 取证包落盘 + 读回重验四重 + 离线自证 + --zstd 物理布局双锚点登记）/ rebuild-index / run 全程逐事件 fsync（「先落日志后放行」物理兑现）+ attachSink + loadSessionLog 格式层接入 + deriveSessionId（修路径当 sessionId 旧账） | §3.2.M7.2 导出行 |
| `test/s22-m7-store-format.spec.ts` + `test/s23-m7-export-index.spec.ts` | M7 测试：8 + 7 个 test（sink 落盘/fail-fast/撕裂尾/格式三语义/zstd 压缩比 ≥3x 与缺席显式/export 离线自证/断链中止/索引幂等/errors 通道） | §3.2.M7 AC |

| `src/load/sigGate.ts` + `src/load/report.ts` verify 阶段 | M5-S28 装载签名门接线：manifestHash = 插件入口文件裸字节 sha256 hex（`<file>.minisig` sidecar，被签消息 = hex 串 UTF-8 字节）+ 流水线五阶段→**六阶段**（discover→**verify**→parse→…，先于 import() 模块执行前拦截）+ `car run` 直载门 + `car reload` 透传 + `car_load_total`/`car_unsigned_confirmed` 生产计数 + `CAR_TRUST_ROOT`/`CAR_SIG_ENFORCE`/`CAR_UNSIGNED_ALLOW` env 通道 + unsignedAllow→confirmed=yes 豁免改写 + fp 指纹横幅 | ADR-003 追记、DEC-1 ②、S20 §5 复评行 |
| `test/s24-signature-gate.spec.ts` | M5-S28 测试：8 个 test（warn 缺签横幅+fp+confirmed=no / unsignedAllow=yes 改写+横幅保留 / enforce 缺签 FAIL+空 plugins / 坏签名硬拒绝不可豁免 / 好签名静默 / load_total 分母 / reload 透传 / 单文件门+env 映射） | 全量 204 |

| `src/runtime-core/`（7 文件）+ `src/kernel` Context 根作用域 `effect()` + `src/dx/doctor.ts` keychain 行 | M8 运行时底座：types DTO（finishReason 不可变透传口径）/ llm.ts（AdapterRegistry 重复 id 显式报错 + withFinishReasonGuard 不可变守卫 + RuntimeCore Effect 可逆注册 + openai-compat SSE 适配器：TLS 强制 / 未映射 finish fail-visible / 首块前重试 ≤2 指数退避 / 凭据门 resolve→reveal→Bearer / A080001 首块前传播）/ credentials（Keychain→env，A080001 引导 car doctor）/ redaction（redact + StreamRedactor 跨 chunk 驻留）/ telemetry（OTel 门面默认关三原则）/ chatStep（SQ-07：N1 前置断言→投影请求→流消费→assistant 落 M7→toolUse 交 M4）/ errors（CarM8Error 双轨码） | §3.2.M8、SQ-07、O-11/O-13/O-14 |
| `test/s25-m8-runtime-core.spec.ts` | M8 测试：27 个 test（注册表/finishReason 守卫/Effect 可逆/凭据三层/脱敏/遥测双路径/openai-compat SSE·重试·凭据门/chatStep 集成六面/SQ-07 端到端） | §3.2.M8 AC |

## M5 状态

- **M5 收口（2026-09-12）**：三项 deferred 全部转正并验证——win32 sandbox spike 四判据自动断言全 PASS（S24/S25/S26）、JSON Schema→TS 深度参数渲染（dee4d67）、跨宿主 fork/resume（03c0fec）。全量 **156/156**。
- 工具面 9→10（新增 `session_fork`）；`session_start` 增 importJsonl 导入路径；RC-3 冻结未生效（1.0-rc tag 未切），工具面契约变更合规登记。
- **S28 收口（2026-09-26）**：**DEC-1 裁决 = ②**（warn + 《签名强制启用指南》组合发布 + RC-3 承诺显式降级；数据窗口 0 会话不满足切 enforce 前提，D-2 红线禁止无数据 enforce；宽限期 = 1.0 发布日 + 90 天，到期 enforce 默认值翻转为**计划内变更**——S20 §5 复评行归档）。配套工程同日收口：**装载签名门接线**——verifier 自 M2-S6（e11d23b）入库零生产调用点的缺口补齐（此前「已实装仅切默认值」口径经双向核查不成立，S20 §6 勘误登记）：loadPlugins 五阶段→六阶段（verify 先于 parse 的 import()，模块执行前拦截）+ car run 直载门 + car reload 透传 + car_load_total/car_unsigned_confirmed 生产计数 + manifestHash 指纹兜底实装 + CAR_TRUST_ROOT/CAR_SIG_ENFORCE/CAR_UNSIGNED_ALLOW env 通道。全量 **204（201 PASS + 3 能力门控 skip / 0 fail）**。S29 前置三修复（ce0bf65）：G-01 钉 tap reporter（Node 23 spec 默认致解析落空）/ G-03 豁免清单对齐 CI 权威版 / release.yml publish tag 动态化（1.0.0→latest，rc 保留指向 rc.1）。**GO-1 复跑达成：12 PASS / 1 DRY-RUN / 0 FAIL**（G-10 Release 实查挂 GO-7 token rotate 后全链验证收口）。
- **S29/S30 收口（2026-09-26）**：**1.0.0 正式发布，M5 全程闭环**。GO-7 token rotate 收官（新 npm token 入 repo secret + PAT `*0Fbq`，全链 13 PASS，旧凭证双撤销）；version 1.0.0（`9435f99`）→ tag v1.0.0 → 发布前彩排 11+2 → Release v1.0.0（用户创建）→ j16 首跑 E403（npm 2FA 策略，bypass token 回退路径兑现）→ re-run 绿 `npm publish --provenance --tag latest` → dist-tags 终态 latest=1.0.0 / rc=rc.1 → Release 资产两件错挂修正 → **post-publish 13 PASS / 0 DRY-RUN / 0 FAIL** → 外部验证者等价检查（SHA256 MATCH + cosign Verified OK）→ S30 终验报告。**宽限期：2026-09-26 → 2026-12-25 到期 enforce 翻转**。

## M6 状态

- **CI 门禁矩阵落地（09-18）**：ci.yml 重写为 16 Job + release.yml=j16（18/18 对齐 M2§2.3+M3§2.2 全景）；新增 landlock-run 原生组件（构建单源 j01）、20 条逃逸矩阵用例（WSL2 实跑 20/20）、Verdaccio registry E2E（15/15）、N1 不变量 100 回放（含篡改检出防假绿）、secrets-scan/contract-check/package-check 脚本门禁、tsc strict 门禁（tsconfig 此前不存在——幽灵门禁同类项）。J-06 macOS 冻结态登记不设 Job。幽灵注释三项门禁全部兑现。
- **CI 首跑全绿（09-18，run 35315943540）**：16/16 Job 在 GitHub Actions 实跑通过——三平台全量 179/179、j05 Linux 逃逸 20/20、**j17 WSL2 逃逸 20/20**（hosted windows-2022 + WSL2 Ubuntu-24.04 实装，E-1 常驻门禁判据兑现）、j07 win32 四判据、j18 registry E2E 全部转正式门禁。首跑排障四连修：CodeQL SARIF 403（补 security-events:write）、j05 artifact 丢执行位（chmod 恢复）、j17 /mnt 不可用（tar 流直灌 ext4）+ WSL1 缺 Landlock（强制 set-version 2）+ CRLF 脚本炸（.gitattributes eol=lf + sed 去 CR）。
- **E-5 万级 secrets 基准集闭环（09-18，M2 退出标准 #4）**：确定性生成 1000 正（25 族）+ 9000 负（5 类对抗面）实测 **漏报 0% / FPR 0% / precision 100%**（D-3 判据 <1.5%/≤5%/≥80% 全过）。基准集首跑即校准出扫描器三处缺陷并修复：AWS Secret 正则对 `aws_secret_access_key` 规范形失配（漏报源）、kv 熵口径算在含键名全 token（弱值逃逸）、连接串占位口令无降级。载体：`test/s7b-baseline.spec.ts` 常驻回归 + `scripts/secrets-baseline.ts` 终验 CLI。180/180 全绿。

- **M6 收口（2026-09-15）**：**179/179 全绿（s1–s20 166 + s21 13，零回归）**；QA 两轮制——Round 1 发现 M6-BUG-1（重名插件被 topo 误报 CAR-E-DEPCYCLE，register CAR-E-DUP 守卫不可达），工程师修复（topoSort 重名安全：pushed/pushedNames 双轨；register DUP 守卫恢复可达 + 全量同名文件冲突链）后 Round 2 PASS。CLI 实测 reload 退出码 0/1/2 ✅、CAR_OFFLINE=1 doctor 离线 PASS ✅。QS-05：20 轮缓存击穿热重载 × 5 插件 P95 个位数 ms（目标 ≤800ms）。
- 口径备注：DUP 拦截点钉在 register 阶段（QA 裁定接受：文档口径 + 冲突链定位质量更优）；topoSort 仅对真实依赖环报 CAR-E-DEPCYCLE。
- 环境备注：测试命令须用 glob 形态 `node --experimental-transform-types --test "test/*.spec.ts"`（目录参数在 Node 22.22.2 下 MODULE_NOT_FOUND）。

## M7 状态

- **M7 收口（2026-09-19）**：§3.2.M7 会话日志与审计规格差距五项全部兑现——W1 落盘存储层（SessionFileStore 单 write 行级原子 + fsync，car run 全程逐事件落盘，「先落日志后放行」从语义到物理）；W2 撕裂尾显式格式校验（崩溃半行显式丢弃报告，撕裂尾/CAR-E-FORMAT/断链三失败语义互斥可判）；W3 zstd 存储增强（能力探测 codec，实测压缩比 6.21x ≥ 3x 规格口径，缺席显式 CAR-E-ZSTD 不静默；热路径恒明文——fail-fast 优先，zstd 定位归档/导出）；W4 `car session export` 取证包 CLI（SQ-06 断链中止 + 落盘读回重验四重 + 离线自证 + --zstd 物理布局双锚点）；W5 `car session rebuild-index`（node:sqlite 单事务幂等重建，errors 通道不吞错，索引只收链完整会话）。全量 **195 测试（192 PASS + 3 能力门控 skip，0 fail）** + tsc strict 0 错。
- **CI 能力真跑（防幽灵门禁）**：j02/j03/j04 测试命令直挂 `--experimental-sqlite`（22.5+ 带 flag 引入）；zstd 为 **22.15+ 原生内置（无 CLI flag**，Stability: 1 实验标记），22.19 原生在场直跑。排障两轮（run 35451413014/35451612564）：①node 运行时 flag 不能走 `NODE_OPTIONS`（白名单拒绝 + job 级 env 炸 actions 自身 node24），必须直挂命令行；②「not allowed in NODE_OPTIONS」是通用拒绝文案、**不代表 flag 存在**——`--experimental-zstd` 从未存在过。zstd 在场/缺席双路径各由在场/缺席环境实跑（skip 显式登记非静默）。**CI 收官（run 35452486131）：16/16 全绿**，三平台 195 用例实跑（zstd 在场路径含 ≥3x 压缩比断言 CI 首次实测通过）。
- 口径备注：§3.2.M7.2 的 `--session id` 形态以 index（sessionId→file 映射）为底座登记后续增强，export 本迭代以文件路径为入口（与 verify/replay 形态一致）；运行时 append 异步索引自动更新登记后续（缺失由 rebuild 兜底，异步可容忍语义自洽）；deriveMessages 的 roleConsistencyChecked 在 v1 无消息改写面，登记 N/A。详见 `car-docs/10-内核v1/M7-会话日志与审计收口.md`。

## M8 状态

- **M8 收口（2026-09-26）**：§3.2.M8 运行时底座（模型接入 A4 + 遥测 A5）收口——WIP 七文件（09-19 产出）经检查点 `93b3938` 入库（kernel 根作用域 effect() 补齐宿主侧 Effect 生命周期 + doctor keychain 通道）后，本迭代交付：**M8-BUG-1 修复**（AL-05 兜底 sawFinish 条件化——成功流零 error chunk，缺失仍显式报错）+ openai-compat SSE/重试/凭据门 8 测试 + chatStep SQ-07 集成 7 测试。全量 **231（228 PASS + 3 能力门控 skip / 0 fail）** + tsc strict 0 错（CI 首跑揪出 93b3938 遗留 strict 错误，`9898563` 修复）+ secrets-scan 97 文件 0 命中（93b3938 夹具命中已修——上次会话 PASS 声明系伪造渲染产物）。**CI 收官（run 36237615992）：16/16 全绿**。
- 口径备注：chatStep 库面已备已测，**runTurn（M4）侧消费接线登记后续**（「已实装」口径不外推）；openai-compat 为参考适配器（ACL 接口面已钉死）；遥测 OTLP 最小实现（无重试/采样）。详见 `car-docs/10-内核v1/M8-运行时底座收口.md`。

## 1.1 状态（签名收尾最小集，enforce 翻转准备）

| `src/load/sign.ts` | 1.1-S1 签名原语：generateSigningKeypair（ed25519 PKCS8 DER / SPKI base64）+ signPluginFile（sidecar `<file>.minisig` 单段 base64）+ resolveTrustRoot（flag > env > pub 文件）——指南 §2 node -e 手工流固化，与 verifier/sigGate 签验同源互验 | 1.1 W2-1 |
| `src/load/config.ts` | 1.1-S3 配置文件通道：`car.config.json`（cwd 发现 + `--config` 显式；D-11a ①）——键位 `sandbox.unsigned.allow`/`sandbox.sig.enforce`/`sandbox.sig.trustRoot`，手写校验 fail-visible（CAR-E-CONFIG：坏 JSON/未知键/类型错显式拒绝）+ mergeSignatureGate 优先级 flag > env > 配置 > 缺省（env 已定义即显式意见） | 1.1 W2-3、部署设计 §4.5.5 |
| `src/dx/doctor.ts` +2 | 1.1-S2 doctorSignature 签名就绪行（mode 生效值含配置层 / 信任根可解析性 / 配置文件发现态）+ doctorKeychain 专测补齐（M8 §4.6「已接线未专测」出清） | 1.1 W2-2/W2-5 |
| `src/cli.ts` | 1.1：`car plugin-sign keygen/sign/verify`（退出码家规 0/1/2；私钥 0600；重复 keygen 拒绝覆盖）+ `--config` 通道接入 run/reload/mcp-serve + **mcp-serve 装载接线**（`--plugin` 可重复 / CAR_PLUGINS env；六阶段门 verify 先于 import()；car_load_total/car_unsigned_confirmed 全链进 stderr 快照；装载 FAIL = 启动中止 exit 1 两模式一致，warn 仅豁免缺签） | 1.1 W2-1/W2-4 |
| `test/s26-signature-closeout.spec.ts` + `test/s27-host-load-wiring.spec.ts` + `test/s18.spec.ts` 边界行 | 1.1 测试：s26 13 test（keygen 签验闭环 / 手工口径字节等价 / CLI spawn 全链退出码 / 配置 fail-visible / 优先级四向 / doctor 三通道 / keychain 平台三态）+ s27 4 test（真进程装载四态：warn 全链 / enforce fail-closed / parse FAIL 不静默 / 配置通道好签名）+ s18 无 --plugin 边界断言 | 1.1-GO |

- **1.1 工程收口（2026-09-27）**：S30 §8 工程侧清单签名收尾五子项全部兑现（plugin-sign CLI / doctor 签名行 / 配置文件通道 / mcp-serve 装载接线+采集全链 / keychain 专测）。全量 **249（246 PASS + 3 能力门控 skip / 0 fail）** + tsc strict 0 错 + secrets-scan 97 文件 0 命中（密钥/签名夹具仅运行期临时目录——R-1）。QA 两轮制执行。**CI 收官（run 36304931085）：16/16 全绿**。
- **1.1 发布编排（S6，D-11b ①直发）**：13 门禁本地预演 **11 PASS / 2 DRY-RUN / 0 FAIL**（G-07 逃逸矩阵本机 WSL 实跑 20/20；G-09/G-10 远端口径 DRY-RUN）；version 1.1.0（`3d8658e`）已推送 main；dist 六资产就绪（tgz/bundle/SHA256SUMS/SBOM/审计/公钥）。**Release v1.1.0 创建（用户）→ j16 自动 `npm publish --provenance --tag latest` → post-publish REMOTE_CHECK=1 复跑**。
- **1.1.0 正式发布（2026-09-27，S6 收官）**：npm `@lqc123qwe/car-runtime@1.1.0` 在架——**dist-tag latest → 1.1.0，rc 保留指向 1.0.0-rc.1**（§1.1 口径）；SLSA provenance（slsa.dev/provenance/v1）。j16 run 36305729712 success；**post-publish 复跑 12 PASS / 1 DRY-RUN / 0 FAIL（G-09 实查 PASS）** + 外部验证者等价检查（Release 实下载件 SHA256 MATCH + cosign Verified OK）+ Release 六资产公开 API 实查齐备。发布工程事件：tag 实挂 `1.1.0`（无 v 前缀）→ G-10 双形态兼容修复（`3fdedf5`，4c84b17 同类）。收口报告：`car-docs/10-内核v1/1.1-签名收口终验报告.md`。
- **边界口径（防外推）**：mcp-serve 装载接线 = 「装载 + 采集全链」——插件 factory 执行 + bindCore 冲刷注册项真实发生；**宿主会话执行插件工具的执行接线属 W1 登记后续**（sessionTurn 仍为事件批归一化），「已实装」口径不外推。sigstore keyless 主轨 / anthropic 适配器 / W1 runTurn→chatStep 接线均为延后登记项（用户裁决 2026-09-27）。
- **翻转排期**：**2026-12-25 到期 enforce 缺省值翻转**落 12-25 后续发版（一行缺省值变更 + 决策记录归档，部署设计 §4.5.5 既有承诺）；数据前提 T-1 阈值随本迭代宿主采集链落成可观测。规划：`car-docs/10-内核v1/1.1-迭代规划.md`；收口报告：`car-docs/10-内核v1/1.1-签名收口终验报告.md`。

## 1.2 状态（会话/遥测小项 W3）

| `src/session/indexStore.ts` +2 | 1.2-S1/S2：`lookupSession`（--session id → 文件；db 缺文件 CAR-E-INDEX 显式报错无建文件副作用；SQLite 惰性校验错误统一收口；未收录 = null「可索引 = 可验证」）+ `upsertSessionRow`（自举建库建表）+ `IndexUpdater`（**按行增量**——sink 先于事件入内存 fail-fast 时序下行自带 seq/hash；debounce 2s + close flush；**失败非致命**绝不阻塞 append；能力缺席显式登记一次后停用；file resolve 绝对化） | M7 §4/§5 登记后续出清 |
| `src/cli.ts` | 1.2：session verify/replay/export 三入口 `--session <id> [--db]`（与位置路径互斥显式拒绝；缺省 db = cwd sessions-index.db）+ `car run` sink 链接 IndexUpdater + mcp-serve **OTel meter 双写桥**（S17 counters 快照面不变 + shutdown flush） | 1.2 W3-1/2/3 |
| `src/runtime-core/telemetry.ts` | 1.2-S3 生产级策略：有界重试（429/5xx/网络 ≤2 退避 1s/2s，4xx 不重试，耗尽静默丢弃永不抛错——**D-12b 口径修订「0 重试」**，隐私三原则不变）+ 采样（always_on 缺省/always_off/{ratio} head 决策，spansSampledOut）+ 批上限（maxBatchSize 512 分批 / maxQueueSize 2048 溢出丢最旧 queueOverflows）+ `telemetryConfigFromEnv`（CAR_OTEL_ENDPOINT 唯一开关/CAR_OTEL_SAMPLING/CAR_OTEL_INTERVAL_MS；非法值保持缺省禁 fail-hard）+ **1.2-BUG-1/2 修复**（OTLP metric 名混入 labels JSON / res.ok 未判 5xx 计成功——均经生产调用点接入暴露） | M8 §4.4 登记后续出清 |
| `test/s28-session-index-followup.spec.ts` + `test/s29-otel-producer.spec.ts` | 1.2 测试：s28 6 test（lookup 四态 / CLI 三入口真进程 / 拒绝面四情形 / updater 自举+覆盖+close / 失败非致命 / car run 索引闭环）+ s29 8 test（env 七态 / 重试四路径 / res.ok 回归钉 / 采样四态 / 分批溢出 / 默认关 / 解耦静态断言 / **mcp-serve 真进程 OTLP 出站实证**） | 1.2-GO |

- **1.2 工程收口（2026-09-27）**：M7 §4/§5 + M8 §4.4 登记后续三子项全部出清。全量 **263（260 PASS + 3 能力门控 skip / 0 fail）** + tsc strict 0 错 + secrets-scan 101 文件 0 命中。QA 两轮制执行。**1.2-BUG-1（OTLP metric 名混 labels）为生产调用点核查直接产出**——meter 桥接入即暴露 M8 最小实现掩盖的缺陷。
- **边界口径（防外推）**：OTel span 面（turn/step span）**仍无生产调用点**（随 W1 登记后续）；trace 传播（parentSpanId/共享 trace）随 W1 设计；mcp-serve 出站现仅 metrics（counter 桥）。
- **遗留登记**：W1 = 1.3 头号候选（含 D-12a TLS loopback 豁免实装、car run 装配面重做〔demo_tool 撞名观察项出清〕）；car run demo_tool 撞名 DEPCYCLE 为预存在边缘（登记不修，W1 出清）。规划：`car-docs/10-内核v1/1.2-迭代规划.md`；收口报告：`car-docs/10-内核v1/1.2-收口终验报告.md`。
- **1.2.0 正式发布（2026-09-27，S5 收官）**：npm `@lqc123qwe/car-runtime@1.2.0` 在架——**dist-tag latest → 1.2.0，rc 保留指向 1.0.0-rc.1**；SLSA provenance（slsa.dev/provenance/v1）。Release `1.2.0`（用户创建，六资产）→ **j16 run 36312617477 success** → **post-publish REMOTE_CHECK=1 复跑 12 PASS / 1 DRY-RUN / 0 FAIL（G-09 实查 PASS）** + 外部验证者等价检查（Release 实下载件 SHA256 MATCH `6d6d4da1…` + cosign Verified OK）。发布工程事件：registry CDN 缓存滞后登记（cache-buster 口径）；制品自 tag 树重建后再挂（消除 1.1 的树漂移）。

- **1.3 发布资产自动化（W4，2026-09-27 收口）**：`scripts/release-artifacts.ts` 制品构建单一事实源（本地流水线/CI j16 双端复用；SHA256SUMS 裸字节自检 G-11 口径 + SBOM G-05 同构 + releaseAssetNames 五件套清单——G-10/CI/测试三方同源）+ release.yml 重构（构建 → cosign keyless 签名〔D-15 正式轨：OIDC+Rekor，CI 零 keypair 材料〕→ `gh release upload --clobber` 五件套 → npm publish 原步不动；**upload 先于 publish**）+ D-14 资产集迁移（car-release.pub 移出——keyless 验证锚 = bundle 证书 + Rekor）+ D-14 tag 形态统一（裸版本号）。s30 六测（构建/清单/同源/yml 结构与步骤序红线）。全量 **269（266 PASS + 3 skip / 0 fail）**。1.3.0 发布 = W4 验收载体（**全链零人工拖拽资产**）。W1 三度延后登记 **1.4 头号候选**（设计账本 D-12a loopback 豁免 + D-13 --demo 保留）。规划：`car-docs/10-内核v1/1.3-迭代规划.md`；收口报告：`car-docs/10-内核v1/1.3-收口终验报告.md`。

## 状态

- **版本主线**：S1-S4 48/48 ｜ M2 89/89（v0.2.0）｜ M3 127/127（v0.3.0）｜ M4 139/139（**1.0.0-rc.1 已发布**）｜ M5 156/156（DEC-4 预埋项转正）｜ M6 179/179（2026-09-15 收口）｜ M7 全量 195（192 PASS + 3 能力门控 skip，2026-09-19 收口）｜ **M5-S28 装载签名门 全量 204（201 PASS + 3 skip，2026-09-26）** ｜ **M8 运行时底座 全量 231（228 PASS + 3 skip，2026-09-26 收口，§3.2 八模块全部收口）** ｜ **1.1 签名收尾最小集 全量 249（246 PASS + 3 skip，2026-09-27 收口，1.1.0 已发布，enforce 翻转准备就绪）** ｜ **1.2 会话/遥测小项 全量 263（260 PASS + 3 skip，2026-09-27 收口，1.2.0 已发布）** ｜ **1.3 发布资产自动化 全量 269（266 PASS + 3 skip，2026-09-27 收口，发布全链去人工拖拽）**
- **1.0.0 正式发布（2026-09-26，S29/S30）**：npm `@lqc123qwe/car-runtime@1.0.0` 在架——**dist-tag latest → 1.0.0，rc 保留指向 1.0.0-rc.1**（§1.1 口径）；SLSA provenance（Actions OIDC，透明日志在案）；GitHub Release v1.0.0 六资产（tgz/bundle/SHA256SUMS/SBOM/审计/公钥）；**post-publish 全链 13 PASS / 0 DRY-RUN / 0 FAIL** + 外部验证者等价检查（Release 实下载件 SHA256 MATCH + cosign Verified OK）。**宽限期时钟：2026-09-26 起算，2026-12-25 到期 verifier 默认值 warn→enforce 翻转（计划内变更）**。终验报告：`car-docs/10-内核v1/M5-S30-1.0收口终验报告.md`。发布工程事件：j16 首跑 E403（npm 2FA 策略 vs granular token 无 bypass——清单预设回退路径兑现）→ bypass token re-run 绿；G-09 期望 tag 动态化（`4c84b17`）在真实发布兑现价值。
- **1.0.0-rc.1 已发布（2026-09-09）**：npm `@lqc123qwe/car-runtime@1.0.0-rc.1`（rc + latest 双 tag，SLSA provenance 在案）+ GitHub Release 6 制品；发布预演 **13 PASS / 0 DRY-RUN / 0 FAIL**（c762b72）。S22 GO 清单已全绿收口。
- **轨道 A 三项全部完成**：E-1 WSL2 逃逸矩阵 **20/20 PASS 零逃逸**（2026-09-07，G-07 转 PASS）｜ E-3 远端发布通道 **13/13 全门禁 PASS**（2026-09-09，G-08/09/10 转 PASS）｜ E-2 Windows koffi FFI **四判据双环境全 PASS**（S24/S25/S26，2026-09-09~10；本机非提权 + windows-latest 提权 runner 双绿，CI 门禁已接入）。
- **决策已闭环**：**T-1** enforce 阈值定稿 **A=5% / B=2% / C=30 会话** + 裁决**显式延期**（2026-09-09，S20 §5 归档；红线禁止以 warn 静默进 1.0）｜**T-4** MLPS-G1 定时导出维持部署方配套（2026-09-09，D-4 追记）｜**DEC-2** Windows CI 接入 / **DEC-3** 发布前 token rotate / **DEC-4** M3 预埋项纳入 1.0（均 2026-09-09 裁决）。
- **1.0-GO 七项全部闭环（2026-09-26）**：GO-1 ✅ **13 PASS / 0 DRY-RUN / 0 FAIL**（全口径复跑——G-10 随 GO-7 新 PAT 转实查 PASS）｜ GO-2/3 ✅ E-2 四判据（S24-S26 双环境）｜ GO-4 ✅ DEC-1 ②（warn 形态，S20 §5 归档）｜ GO-5 由 DEC-1 ② 承接（R-1 缓解路径：试点 0 家不阻塞 ② 形态发布，征集转运营侧持续项）｜ GO-6 ✅ 部署设计 §4.5.5 ｜ GO-7 ✅ token rotate（npm granular token 入 repo secret + PAT `*0Fbq`；旧凭证双撤销；全链 13 PASS）。同日收口 S29 前置修复（`ce0bf65` G-01 钉 tap / G-03 豁免对齐 CI / release.yml tag 动态化；`4c84b17` G-09 期望 tag 按版本形态动态选择——硬编码查 rc 会把 1.0.0 post-publish 复跑误判 FAIL）。**剩余 = S29 发布编排 → S30 收口终验**。
- M4 预埋项**已全部出清**：fork 跨宿主 / 深度参数渲染于 2026-09-12 转正（dee4d67 + 03c0fec）；定时导出经 T-4 裁决维持部署方配套。
- **内核行为修复（S14 捕获）**：工具异常原会终止 turn（reason=error）——已修为「成对错误 toolResult 交回模型」（US-5/D5 语义：工具错误是结果而非 turn 中断），121 断言零回退。
- **性能定标（回填）**：N2 首插件跑通 3ms（目标 ≤300s，余量 10 万倍）｜ Q-06 装配 20 插件 <1ms、serial 分发 1000 次 6ms、日志 1 万事件追加+哈希链 125ms、回放+校验 21ms ｜ QS-05 20 轮缓存击穿热重载 × 5 插件 P95 个位数 ms（目标 ≤800ms）。
- **历史留存**（早期里程碑，均已闭环或经裁决移交）：M3 环境动作清单 E-1~E-4 + E-6 宿主实连试点见 `car-docs/10-内核v1/M3收口终验报告.md`；M2 清单 E-1~E-5 与 T-8 移交见 `M2收口终验报告.md`；G-03 豁免机制——secrets 规则库/标定基准显式列文件豁免，清单变更需评审。
- **遗留（非阻塞）**：jiti 实装补测首载时延（载体替身已验证不变量）。POC-4 Linux/WSL2 实跑已随 E-1 完成（20/20）。
