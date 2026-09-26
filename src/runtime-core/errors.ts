/**
 * M8 · 错误面（《系统设计》§3.5.1 六位错误码 + 代码库 CAR-E-* 前缀双轨）
 *
 *  - A080001 凭据缺失：不重试，用户文案引导 car doctor（SQ-07 凭据缺失分支）；
 *  - B080001 LLM Provider 不可达/重试耗尽：退避后重试（§3.5.4 基线——2 次指数退避 1s/2s）；
 *  - 两条均为「错误路径不改写 finishReason 语义」的守门错误：流中途失败以
 *    finishReason='error' chunk 收口（BD-04），首块前失败以 CarError 抛出（runTurn catch → turn error）。
 */

export type M8ErrorCode = 'A080001' | 'B080001'

export class CarM8Error extends Error {
  constructor(
    /** 六位错误码（§3.5.1 注册表） */
    readonly code: M8ErrorCode,
    /** CAR-E-* 代码库前缀（与 CAR-E-DEPCYCLE 等同风格） */
    readonly slug: string,
    message: string,
    /** 用户文案（§3.5.1 注册表原文） */
    readonly userHint?: string,
    /** 重试建议（A080001 不重试 / B080001 退避后重试） */
    readonly retryable = false,
  ) {
    super(`${slug}: ${message}（${code}）`)
    this.name = 'CarM8Error'
  }
}

export function credentialMissing(provider: string, searched: string[]): CarM8Error {
  return new CarM8Error(
    'A080001',
    'CAR-E-CRED-MISSING',
    `未找到模型服务凭据（provider=${provider}，已检索：${searched.join('、') || '无可用通道'}）`,
    '未找到模型服务凭据，请运行 car doctor',
    false,
  )
}

export function providerUnreachable(detail: string): CarM8Error {
  return new CarM8Error(
    'B080001',
    'CAR-E-LLM-UNREACHABLE',
    `LLM Provider 不可达/重试耗尽：${detail}`,
    '模型服务暂时不可用，本轮已停止',
    true,
  )
}
