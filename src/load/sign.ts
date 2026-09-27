/**
 * 1.1-S1 · plugin-sign 签名原语（keygen / sign 纯函数；verify 复用 sigGate.verifyPluginFile）
 *
 * 口径（与 M2-S6 verifier / M5-S28 sigGate 签验同源，逐字对齐签名强制启用指南 §2）：
 *  - 被签物 = 插件入口 .ts 文件裸字节 sha256 的 hex 串；被签消息 = hex 字符串的 UTF-8 字节
 *    （sigGate.ts 头注释同源；哈希对裸字节求——G-11 教训：禁止对编码文本求哈希）
 *  - 私钥 = ed25519 PKCS8 DER 文件（<前缀>.priv）；公钥 = SPKI DER base64（<前缀>.pub，
 *    即 CAR_TRUST_ROOT 信任根值）；sidecar = `<file>.minisig` 单段 base64（sigGate 读取口径）
 *  - 本模块只产出密钥与签名；门禁判定（warn/enforce 分级、fail-closed 分级）在 verifier/sigGate——
 *    sign 不判门。边界登记（1.1 规划 W2-1）：minisign 离线单轨；sigstore keyless 主轨延后（1.2 候选）
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

export interface SigningKeypair {
  /** PKCS8 DER 私钥字节（写 <前缀>.priv；离线保管不入仓库——secrets 红线） */
  privateKeyDer: Buffer
  /** SPKI DER base64 公钥（写 <前缀>.pub；即 CAR_TRUST_ROOT 信任根值） */
  publicKeyBase64: string
}

/** ed25519 签名密钥对生成（指南 §2 第 1 步 node -e 流程固化） */
export function generateSigningKeypair(): SigningKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyDer: privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

export interface SignResult {
  file: string
  sidecar: string
  /** 文件裸字节 sha256 hex（横幅指纹与审计留痕口径同 sigGate.manifestHash） */
  manifestHash: string
}

/** 对单文件签名并写 sidecar `<file>.minisig`（指南 §2 第 2 步 node -e 流程固化） */
export function signPluginFile(file: string, privateKeyDer: Buffer): SignResult {
  const manifestHash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const minisig = cryptoSign(null, Buffer.from(manifestHash), { key: privateKeyDer, format: 'der', type: 'pkcs8' }).toString('base64')
  const sidecar = `${file}.minisig`
  writeFileSync(sidecar, minisig)
  return { file, sidecar, manifestHash }
}

/** 信任根解析（plugin-sign verify 用）：显式 flag > CAR_TRUST_ROOT env > <前缀>.pub 文件 */
export function resolveTrustRoot(opts: { flag?: string; env?: NodeJS.ProcessEnv; pubFilePath?: string }): { value?: string; source: 'flag' | 'env' | 'pubfile' | 'none' } {
  if (opts.flag) return { value: opts.flag, source: 'flag' }
  const envVal = opts.env?.CAR_TRUST_ROOT
  if (envVal) return { value: envVal, source: 'env' }
  const pub = opts.pubFilePath
  if (pub) {
    try {
      const v = readFileSync(pub, 'utf-8').trim()
      if (v) return { value: v, source: 'pubfile' }
    } catch { /* pub 文件不可读 → 视同未提供，由调用方显式报错 */ }
  }
  return { value: undefined, source: 'none' }
}
