#!/usr/bin/env node
/**
 * 1.18-K5（T-K5-1）：P1 真实网关缓存探针——P2 滚动断点门条件实测（V2 授权，预算 ≤ 5 万 token）。
 *
 * 做什么：同一请求体（system ≥ 1024 token 门槛 + 短 user）打真实网关两次，读回
 *         anthropic usage 的 cache_creation / cache_read 三态结论：
 *           A = 兑现（c1 creation>0 且 c2 read>0 → P2 放行）
 *           B = 不兑现（双零 → P2 在本网关判死；P1 保留无害）
 *           C = 部分兑现（按实测数据裁决）
 * 纪律：mock 禁作证据（设计 §10.5-2）；密钥仅经 CredentialService resolve→reveal，不入任何输出；
 *       只读网关，不写仓库文件。
 * 用法：node --experimental-transform-types tools/cache-probe.mjs
 * env：ANTHROPIC_API_KEY（必需）+ CAR_ALLOW_ENV_CREDENTIALS=1（env 通道显式开启）
 */
import { createAnthropicAdapter } from '../src/runtime-core/llm.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'

const BASE_URL = process.env.CAR_PROBE_BASE_URL ?? 'https://token.sensenova.cn'
const MODEL = process.env.CAR_PROBE_MODEL ?? 'glm-5.2'

// system 事实拼装（确定性填充，无敏感内容）：24 段 × ~200 汉字 ≈ 4800 字，
// 任何主流 tokenizer 下均 ≥ 1024 token 门槛（Anthropic prompt cache 最小长度）。
const SYSTEM = Array.from({ length: 24 }, (_, i) =>
  `【探针基线段 ${i + 1}】本段为提示缓存探针的确定性填充文本，用于跨过服务端缓存最小长度门槛。` +
  `内容为事实性描述：本会话由内核探针脚本发起，目的在于测量传输层 cache_control 断点是否被网关兑现。` +
  `填充段落编号为 ${i + 1}，其余段落与本文本逐字一致，仅编号不同。`,
).join('\n\n')

const USER = '只回复两个字：收到'

const adapter = createAnthropicAdapter({
  baseUrl: BASE_URL,
  // 探针 = env 专用通道（keychain 通道注入恒空——不触碰用户凭据库）
  credentials: new CredentialService({ keychainReader: () => null }),
})

/** 单次真实调用：消费整流，回收 usage / finishReason / error（chunk 契约：usage 附着末 chunk） */
async function call(label) {
  let usage
  let finishReason
  let error
  try {
    for await (const c of adapter.chat({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
      tools: [],
      maxTokens: 64,
    })) {
      if (c.usage) usage = c.usage
      if (c.finishReason !== undefined) finishReason = c.finishReason
      if (c.error) error = c.error
    }
  } catch (e) {
    error = e
  }
  return { label, finishReason, error, usage }
}

const c1 = await call('call-1')
const c2 = await call('call-2')

const line = (r) => {
  const u = r.usage
  const raw = u?.providerRaw?.messageStart ?? {}
  return [
    `${r.label}: finish=${r.finishReason ?? 'n/a'}`,
    `error=${r.error ? String(r.error.message ?? r.error).slice(0, 160) : 'none'}`,
    `input=${u?.inputTokens ?? 'n/a'} output=${u?.outputTokens ?? 'n/a'}`,
    `cacheRead=${u?.cacheReadTokens ?? 'n/a'} cacheCreation=${u?.cacheCreationTokens ?? 'n/a'}`,
    `rawKeys(messageStart)=${Object.keys(raw).join(',')}`,
  ].join(' | ')
}
console.log(line(c1))
console.log(line(c2))
console.log(`systemChars=${SYSTEM.length} model=${MODEL} baseUrl=${BASE_URL}`)

const cr1 = c1.usage?.cacheCreationTokens ?? 0
const rr2 = c2.usage?.cacheReadTokens ?? 0
const verdict = cr1 > 0 && rr2 > 0 ? 'A' : cr1 === 0 && rr2 === 0 ? 'B' : 'C'
console.log(`VERDICT=${verdict} (call1.cacheCreation=${cr1}, call2.cacheRead=${rr2})`)
console.log(verdict === 'A'
  ? 'A：网关兑现 cache_control 断点——P2 滚动断点放行（T-K5-2）'
  : verdict === 'B'
    ? 'B：网关不兑现（或不回执缓存字段）——P2 在本网关判死登记，P1 保留无害'
    : 'C：部分兑现——按实测数据裁决（providerRaw 供对拍）')
