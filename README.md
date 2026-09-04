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

## 状态

- S1：F1/F9/F2/N1 ✅（14）｜ S2：F7/F5/F6 ✅（+17）｜ S3：F3/F4/F8 ✅（+14）｜ S4：E2E+N2+Q-06 ✅（+3，累计 48/48）
- **N2 实测**：首插件跑通 3ms（目标 ≤300s，余量 10 万倍）
- **Q-06 定标回填**：装配 20 插件 <1ms；serial 分发 1000 次 6ms；日志 1 万事件追加+哈希链 125ms、回放+校验 21ms
- 待办：jiti 实装补测首载时延（载体替身已验证不变量）；POC-4 Linux/WSL2 实跑；发布工程预演（dist-tag beta）
