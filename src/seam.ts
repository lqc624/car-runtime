/**
 * KernelSeam 公开导出面（1.10.0 加法——D16 T-6 冻结面口径：本文件即内核库形态的 semver 承诺面）
 *
 * 消费方：CAR 平台层（KernelSeam 适配器）；约定：
 *  - 仅暴露进程内挂接所需的最窄面（装配/会话/turn/遥测），禁止透出内核内部模块路径语义；
 *  - 破坏性变更须内核 major；加法演进走 minor 并在本文件头登记；
 *  - 语义不变：runTurn/chatStep/SessionLog 即 CLI 与测试承载的同一实现（非转发壳）。
 *
 * 加法登记：1.11.0 —— AuthzService/checkCapability 出面（平台确认桥幂等决策 + 会话策略直判承载；F4 US-3 语义同源）。
 * 加法登记：1.12.0 —— MCP/PTC 真桥出面（D-20/D-35/D-36：McpGateway + 双 transport 工厂 + resolveMcpHeaders +
 *   makePtcToolDefinition + renderSdkFromRegistry + 8 类型）。负面清单（不出面）：worker-entry/budget/erasable/
 *   runCode（PTC 红线单点——erasable-only/预算/授权门仅经 makePtcToolDefinition 行为面可达）、JsonRpc 编码层、
 *   rawPost/parseTraceparent/formatTraceparent（trace 通道内部件）。jiti epoch 面（D-37）：mountPlugin.reloadEpoch
 *   自 1.10.0 起已随本面可达，零加法登记确认。
 * 加法登记：1.13.0 —— 桌面 S3 治理面（文件安全设计 §7 / S3 迭代规划 D-S3-1）：K-FS-4 redact 出面（fs_read 落链前
 *   脱敏——链上不得进密钥原文）+ K-S3-1 loadSessionLog/deriveSessionId 出面（审计页历史会话链校验/取证导出的
 *   只读载入面；载入/校验单一权威在内核，桌面禁自实现哈希重算）+ K-S3-3 exportForensicsBundle/verifyBundle 出面
 *   （取证包导出 + 读回重验；断链即中止语义随本面）。恢复面 K-S3-2 零登记确认：SessionLog.fromEvents 自 M5 DEC-4
 *   起已随本面可达（fork.ts 生产调用点），S2 D-S2-6 前提修正登记（S3 执行期发现）。
 * 加法登记：1.14.0 —— PluginManager 装载报告面（K-S4-1 / D-43）：loadPlugins 出面（六阶段流水线
 *   discover/verify/parse/validate/topo/register——LoadReportVO 结构化 VO，verify/topo 真值取代 v0.1 桌面
 *   mountPlugin 组合呈现的 SKIPPED 标注）+ ReloadManager 出面（热重载 epoch 击穿 + invalidate 语义随本面）+
 *   verifyPluginFile 出面（签名校验挂载点——宿主自有装载路径可复用同一签名门；minisign 轨唯一实装，sigstore
 *   主轨维持 verifier 骨架期预留——D-43 裁决：登记 strict 期限不引入 sigstore 依赖，engines 硬不兼容见评估报告）。
 * 加法登记：1.14.1 —— B2 前置补出面（1.14 消费面完成）：K-MP-2 压缩行为 API（shouldCompact/applyCompaction
 *   + CompactionConfig——自动挂载点在宿主装配层〔runTurn 之间〕，立即压缩 API 独立可用，append-only 红线随本面）
 *   + K-POOL-1 池装配行为 API（assembleModelPool/probePoolMember + PoolMember/RoutingDecision 类型——
 *   桌面模型池设置 UI 与 doctor 池健康行消费面；routing/decide 落链由宿主接线 onDecide）。
 */
export { SessionLog, loadSessionLog, deriveSessionId, type SessionEvent, type EventKind, type Actor } from './session/log.ts'
export { SessionFileStore } from './session/store.ts'
export { runTurn, type TurnEndReason, type TurnPreset, type TurnResult } from './loop/stop.ts'
export { chatStep } from './runtime-core/chatStep.ts'
export { RuntimeCore, createOpenAICompatAdapter, createAnthropicAdapter } from './runtime-core/llm.ts'
export { CredentialService } from './runtime-core/credentials.ts'
export type { LlmAdapter, LlmRequest, LlmChunk } from './runtime-core/types.ts'
export { mountPlugin } from './load/loader.ts'
export { Context } from './kernel/context.ts'
export { loadCarConfig, mergeLlmConfig, mergeSignatureGate, warmCarConfig, type CarConfig, type LlmConfig } from './load/config.ts'
export { probeCapabilities, SandboxExecutor } from './sandbox/sandbox.ts'
export { AuthzService, checkCapability, type Decision, type AuthzRequest, type AuthzDecision, type DeclaredCapabilities } from './authz/authz.ts'
export { createTelemetryFacade, telemetryConfigFromEnv } from './runtime-core/telemetry.ts'
export { TurnTracer, type TurnSpanHandle } from './runtime-core/trace.ts'
// —— 1.12.0（D-20/D-35/D-36）：MCP/PTC 真桥面 ——
export { McpGateway, type ClientTransport, type McpServerConfig, type McpToolDefinition } from './mcp/gateway.ts'
export { createStdioClientTransport, type StdioServerSpec } from './mcp/stdioClient.ts'
export { createHttpMcpTransport, resolveMcpHeaders, type HttpMcpServerSpec } from './mcp/httpClient.ts'
export { makePtcToolDefinition, type ToolBridge } from './ptc/runCode.ts'
export { renderSdkFromRegistry } from './ptc/sdk.ts'
export type { McpClientSpanHandle, PtcRelayHandle } from './runtime-core/trace.ts'
// —— 1.13.0：桌面 S3 治理面（文件安全/审计/取证）——
export { redact, type RedactionResult } from './runtime-core/redaction.ts'
export { exportForensicsBundle, verifyBundle, type ForensicsBundle, type ExportMeta } from './session/export.ts'
// —— 1.14.0（K-S4-1 / D-43）：PluginManager 装载报告面 + 签名校验挂载点 ——
export { loadPlugins, ReloadManager, type LoadReportVO, type LoadPluginsResult, type LoadPluginsOptions, type LoadStage, type StageStatus, type PeerConflictChain } from './load/report.ts'
export { verifyPluginFile, type SignatureGateOptions, type SigGateResult } from './load/sigGate.ts'
// —— 1.14.1（B2 前置补出面）：K-MP-2 压缩行为 API + K-POOL-1 池装配行为 API（1.14 消费面完成）——
export { shouldCompact, applyCompaction, type CompactionConfig } from './session/compact.ts'
export { assembleModelPool, probePoolMember, type PoolMember, type PoolMemberHealth, type RoutingDecision, type RoutingAttempt } from './load/pool.ts'
