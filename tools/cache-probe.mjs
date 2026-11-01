#!/usr/bin/env node
/**
 * 1.18-K5（T-K5-1）→ 1.18.1-K6-B 升级版：P1 真实网关缓存探针——P2 滚动断点门条件实测。
 *
 * 做什么：同一请求体（system ≥ 1024 token 门槛 + 短 user）打真实网关两次，读回
 *         anthropic usage 的 cache_creation / cache_read 三态结论：
 *           A = 兑现（c2 读侧 > 0 → P2 放行评估）
 *           B = 不兑现（双零 → P2 在本网关判死登记；P1 保留无害）
 *           C = 部分兑现（按实测数据裁决）
 *
 * 1.18.1-K6-B（2026-10-25）：
 *   - ①K5 判死依据修正：昨日 VERDICT=B 建立在归一化层 cacheRead 恒 0 上——装机会话实证
 *     商汤网关把 input 侧三键放 message_delta.usage（message_start 常为 0），归一化漏读
 *     （19/19 事件实证，K6-A 修复）。本探针升级为双口径：归一化层（K6-A 修复后 src 直跑）
 *     + providerRaw.messageDelta 原始层，判据以 delta 层为准（原始事实层优先）。
 *   - ②四槽位循环：glm-5.2 / kimi-k3 / deepseek-flash / sensenova-6.8-flash-lite，
 *     每槽位 2 次调用 × ~2k input token ≈ 总预算 ≤ 5 万 token（V2 授权口径延续）。
 *   - ③本探针同时是 K6-A 修复的真实通路验证面（归一化层三键应出真值）。
 *
 * 纪律：mock 禁作证据（设计 §10.5-2）；密钥仅经 CredentialService resolve→reveal，不入任何输出；
 *       只读网关，不写仓库文件。
 * 用法：node --experimental-transform-types tools/cache-probe.mjs
 * env：ANTHROPIC_API_KEY（必需）+ CAR_ALLOW_ENV_CREDENTIALS=1（env 通道显式开启）；
 *      CAR_PROBE_MODEL 覆盖为单槽位；CAR_PROBE_BASE_URL 覆盖网关（默认商汤）。
 */
import { createAnthropicAdapter } from '../src/runtime-core/llm.ts'
import { CredentialService } from '../src/runtime-core/credentials.ts'

const BASE_URL = process.env.CAR_PROBE_BASE_URL ?? 'https://token.sensenova.cn'
const MODELS = process.env.CAR_PROBE_MODEL
  ? [process.env.CAR_PROBE_MODEL]
  : ['glm-5.2', 'kimi-k3', 'deepseek-flash', 'sensenova-6.8-flash-lite']

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
async function call(label, model) {
  let usage
  let finishReason
  let error
  try {
    for await (const c of adapter.chat({
      model,
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

const line = (r) => {
  const u = r.usage
  const ms = u?.providerRaw?.messageStart ?? {}
  const md = u?.providerRaw?.messageDelta ?? {}
  return [
    `${r.label}: finish=${r.finishReason ?? 'n/a'}`,
    `error=${r.error ? String(r.error.message ?? r.error).slice(0, 160) : 'none'}`,
    `norm(input=${u?.inputTokens ?? 'n/a'},cacheRead=${u?.cacheReadTokens ?? 'n/a'},cacheCreation=${u?.cacheCreationTokens ?? 'n/a'},output=${u?.outputTokens ?? 'n/a'})`,
    `ms(it=${ms.input_tokens ?? '-'},cr=${ms.cache_read_input_tokens ?? '-'},cc=${ms.cache_creation_input_tokens ?? '-'})`,
    `md(it=${md.input_tokens ?? '-'},cr=${md.cache_read_input_tokens ?? '-'},cc=${md.cache_creation_input_tokens ?? '-'})`,
  ].join(' | ')
}

console.log(`systemChars=${SYSTEM.length} baseUrl=${BASE_URL} slots=${MODELS.length}`)
const verdicts = []
for (const model of MODELS) {
  console.log(`---- slot ${model} ----`)
  const c1 = await call('call-1', model)
  const c2 = await call('call-2', model)
  console.log(line(c1))
  console.log(line(c2))

  // K6-B 双口径判定：delta 原始层为事实源（K5 判死教训：归一化层可吃掉证据）
  const dCr2 = Number(c2.usage?.providerRaw?.messageDelta?.cache_read_input_tokens ?? 0)
  const dCc1 = Number(c1.usage?.providerRaw?.messageDelta?.cache_creation_input_tokens ?? 0)
  const msCr2 = Number(c2.usage?.providerRaw?.messageStart?.cache_read_input_tokens ?? 0)
  const nCr2 = c2.usage?.cacheReadTokens ?? 0
  const readHit = dCr2 > 0 || msCr2 > 0
  const writeSeen = dCc1 > 0
  const verdict = readHit ? 'A' : (writeSeen ? 'C' : 'B')
  verdicts.push({ model, verdict, dCr2, dCc1, nCr2 })
  console.log(
    `VERDICT=${verdict} (delta.c1.creation=${dCc1}, delta.c2.read=${dCr2}, start.c2.read=${msCr2}, norm.c2.read=${nCr2})`,
  )
}

console.log('==== summary ====')
for (const v of verdicts) {
  console.log(`${v.model}: ${v.verdict} (deltaRead=${v.dCr2}, deltaCreation=${v.dCc1}, normRead=${v.nCr2})`)
}
const anyA = verdicts.some((v) => v.verdict === 'A')
console.log(anyA
  ? 'A（至少一槽位读侧命中）：网关兑现 cache_control 断点——P2 从判死转重开评估（1.16 设计 §3.3 分期门槛）'
  : verdicts.every((v) => v.verdict === 'B')
    ? 'B（全部槽位双零）：网关不兑现（或不回执缓存字段）——P2 判死维持'
    : 'C（部分兑现/写侧无回执）——按实测数据裁决（providerRaw 供对拍）')
