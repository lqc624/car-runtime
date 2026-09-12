/**
 * T-2+ · JSON Schema → TS 深度参数渲染（M5 · DEC-4 预埋项转正，原 M3-S16 评估项）
 *
 * 口径（M3系统设计增补 T-2 预埋 / M4演进规划 RC-3 / M5 DEC-4 用户裁决①）：
 *  - 渲染源仍为注册表快照同一条目（声明面 = 授权面红线不变）——inputSchema 只是
 *    ToolBridge/McpToolDefinition 上的附加字段，不引入独立声明通道；
 *  - 深度转换 **fail-visible**：超深 / 不支持节点（$ref、not）/ 畸形输入落 `unknown`
 *    并以内联注释标记原因（禁止静默截断——N1「零静默」纪律在类型面上的延伸）；
 *  - 输入 = MCP tools/list 的 inputSchema（JSON Schema 2020-12 常用子集）。
 */

/** 递归深度上限：超过即 fail-visible 落 unknown（防 schema 爆栈与 prompt 膨胀） */
const MAX_DEPTH = 6

function literal(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 属性名合法标识符则裸写，否则 JSON 字符串引号（保留字在 TS 属性位合法，无需处理） */
function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

/**
 * JSON Schema 节点 → TS 类型表达式（深度递归）。
 * 任何不可判定路径返回带内联原因标记的 unknown 字符串（形如 unknown + 注释）——可读、可测、不静默。
 */
export function jsonSchemaToTs(schema: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return 'unknown /* depth>' + MAX_DEPTH + ' */'
  if (!isObject(schema)) return 'unknown /* malformed */'

  // $ref 无法在无注册表上下文解析 → fail-visible（不做猜测性内联）
  if (typeof schema.$ref === 'string') return 'unknown /* unsupported:$ref */'

  // const / enum → 字面量联合（优先于 type）
  if ('const' in schema) return literal(schema.const)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(literal).join(' | ')

  // 组合器：anyOf/oneOf → 联合；allOf → 交叉
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      return schema[key].map((s: unknown) => jsonSchemaToTs(s, depth + 1)).join(' | ')
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((s: unknown) => jsonSchemaToTs(s, depth + 1)).join(' & ')
  }
  if ('not' in schema) return 'unknown /* unsupported:not */'

  // type 可能是单值或数组（['string','null'] → 联合）
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === 'string' ? [schema.type] : []

  if (types.includes('object') || 'properties' in schema || 'additionalProperties' in schema) {
    const props = isObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
    const parts: string[] = []
    for (const [name, sub] of Object.entries(props)) {
      const opt = required.includes(name) ? '' : '?'
      parts.push(`${propKey(name)}${opt}: ${jsonSchemaToTs(sub, depth + 1)}`)
    }
    const addl = schema.additionalProperties
    if (isObject(addl)) {
      parts.push(`[k: string]: ${jsonSchemaToTs(addl, depth + 1)}`)
    } else if (parts.length === 0) {
      // {} / { additionalProperties: true } / 空 object → 任意键值（TS 语法要求 index signature 兜底）
      return 'Record<string, unknown>'
    }
    return `{ ${parts.join('; ')} }`
  }

  if (types.includes('array') || 'items' in schema || 'prefixItems' in schema) {
    if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
      return `[${schema.prefixItems.map((s: unknown) => jsonSchemaToTs(s, depth + 1)).join(', ')}]`
    }
    if ('items' in schema) {
      // 2020-12：items 为单 schema（draft-07 数组形态按 tuple 兼容处理）
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map((s: unknown) => jsonSchemaToTs(s, depth + 1)).join(', ')}]`
      }
      return `${jsonSchemaToTs(schema.items, depth + 1)}[]`
    }
    return 'unknown[]'
  }

  if (types.length > 0) {
    const mapped = types.map((t) => (t === 'integer' ? 'number' : t === 'string' ? 'string' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'null' ? 'null' : 'unknown /* unsupported:type:' + String(t) + ' */'))
    return [...new Set(mapped)].join(' | ')
  }

  // 无 type / 组合器的开放 schema（true、{}）→ unknown
  return 'unknown /* open */'
}
