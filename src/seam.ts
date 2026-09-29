/**
 * KernelSeam 公开导出面（1.10.0 加法——D16 T-6 冻结面口径：本文件即内核库形态的 semver 承诺面）
 *
 * 消费方：CAR 平台层（KernelSeam 适配器）；约定：
 *  - 仅暴露进程内挂接所需的最窄面（装配/会话/turn/遥测），禁止透出内核内部模块路径语义；
 *  - 破坏性变更须内核 major；加法演进走 minor 并在本文件头登记；
 *  - 语义不变：runTurn/chatStep/SessionLog 即 CLI 与测试承载的同一实现（非转发壳）。
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
export { createTelemetryFacade, telemetryConfigFromEnv } from './runtime-core/telemetry.ts'
export { TurnTracer, type TurnSpanHandle } from './runtime-core/trace.ts'
