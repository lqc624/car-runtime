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
 */
export { SessionLog, type SessionEvent, type EventKind, type Actor } from './session/log.ts'
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
