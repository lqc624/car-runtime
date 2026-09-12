import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonSchemaToTs } from '../src/ptc/schemaRender.ts'
import { renderSdkFromRegistry } from '../src/ptc/sdk.ts'
import { McpGateway, type ClientTransport, type JsonRpcRequest, type JsonRpcResponse } from '../src/mcp/gateway.ts'
import type { ToolBridge } from '../src/ptc/runCode.ts'

// ==================== jsonSchemaToTs：深度转换矩阵 ====================

test('schema→TS: 基础标量 + integer 归一 + 可空联合', () => {
  assert.equal(jsonSchemaToTs({ type: 'string' }), 'string')
  assert.equal(jsonSchemaToTs({ type: 'integer' }), 'number')
  assert.equal(jsonSchemaToTs({ type: ['string', 'null'] }), 'string | null')
  assert.equal(jsonSchemaToTs({ type: 'boolean' }), 'boolean')
})

test('schema→TS: const/enum 字面量联合', () => {
  assert.equal(jsonSchemaToTs({ const: 'fixed' }), '"fixed"')
  assert.equal(jsonSchemaToTs({ enum: ['a', 'b', 3, true] }), '"a" | "b" | 3 | true')
})

test('schema→TS: 嵌套 object（required 必填 / 缺省可选 ?）', () => {
  const ts = jsonSchemaToTs({
    type: 'object',
    properties: {
      path: { type: 'string' },
      encoding: { type: 'string', enum: ['utf8', 'gbk'] },
      depth: { type: 'integer' },
    },
    required: ['path'],
  })
  assert.equal(ts, '{ path: string; encoding?: "utf8" | "gbk"; depth?: number }')
})

test('schema→TS: 数组 / 元组(prefixItems) / Record(additionalProperties)', () => {
  assert.equal(jsonSchemaToTs({ type: 'array', items: { type: 'number' } }), 'number[]')
  assert.equal(jsonSchemaToTs({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] }), '[string, number]')
  assert.equal(jsonSchemaToTs({ type: 'object', additionalProperties: { type: 'string' } }), '{ [k: string]: string }')
  assert.equal(jsonSchemaToTs({ type: 'object' }), 'Record<string, unknown>')
})

test('schema→TS: 深层嵌套对象递归', () => {
  const ts = jsonSchemaToTs({
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required: ['tags'],
      },
    },
    required: ['filter'],
  })
  assert.equal(ts, '{ filter: { tags: string[] } }')
})

test('schema→TS: 组合器 anyOf 联合 / allOf 交叉', () => {
  assert.equal(jsonSchemaToTs({ anyOf: [{ type: 'string' }, { type: 'number' }] }), 'string | number')
  assert.equal(jsonSchemaToTs({ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] }),
    '{ a?: string } & { b?: number }')
})

test('schema→TS: fail-visible——$ref/not/畸形/超深落 unknown 且带原因标记（零静默）', () => {
  assert.equal(jsonSchemaToTs({ $ref: '#/$defs/x' }), 'unknown /* unsupported:$ref */')
  assert.equal(jsonSchemaToTs({ not: { type: 'string' } }), 'unknown /* unsupported:not */')
  assert.equal(jsonSchemaToTs(null), 'unknown /* malformed */')
  assert.equal(jsonSchemaToTs('garbage'), 'unknown /* malformed */')
  // 超深递归：MAX_DEPTH=6，第 8 层触发标记
  let deep: Record<string, unknown> = { type: 'string' }
  for (let i = 0; i < 8; i++) deep = { type: 'object', properties: { nest: deep }, required: ['nest'] }
  const ts = jsonSchemaToTs(deep)
  assert.ok(ts.includes('unknown /* depth>6 */'), '超深节点带标记: ' + ts.slice(-60))
})

// ==================== SDK 渲染集成（优先级 + 一致性红线不回退） ====================

test('SDK 渲染: inputSchema 深度转换生效；paramHint 手写声明优先；无声明落 unknown', () => {
  const reg = new Map<string, ToolBridge & { description?: string; paramHint?: string; inputSchema?: unknown }>([
    ['fs_read', { run: async () => {}, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    ['fs_write', { run: async () => {}, paramHint: 'args: { data: string }', inputSchema: { type: 'object' } }],
    ['legacy', { run: async () => {} }],
  ])
  const sdk = renderSdkFromRegistry(reg)
  assert.ok(sdk.includes('"fs_read": ({ path: string }) => Promise<unknown>'), 'inputSchema 深渲生效')
  assert.ok(sdk.includes('"fs_write": (args: { data: string }) => Promise<unknown>'), 'paramHint 优先于 inputSchema')
  assert.ok(sdk.includes('"legacy": (args: unknown) => Promise<unknown>'), '无声明落 unknown（fail-visible 默认不变）')
})

test('SDK 渲染: inputSchema 深渲中 fail-visible 标记直接进声明面（模型可见）', () => {
  const reg = new Map<string, ToolBridge & { inputSchema?: unknown }>([
    ['ref_tool', { run: async () => {}, inputSchema: { type: 'object', properties: { cfg: { $ref: '#/$defs/Config' } } } }],
  ])
  const sdk = renderSdkFromRegistry(reg)
  assert.ok(sdk.includes('cfg?: unknown /* unsupported:$ref */'), '不可判定路径模型可见（不静默截断）')
})

// ==================== McpGateway inputSchema 捕获（DEC-4 消费源接线） ====================

function schemaTransport(): ClientTransport {
  return {
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse> {
      if (req.method === 'tools/list') {
        return {
          jsonrpc: '2.0', id: req.id,
          result: { tools: [
            {
              name: 'ts_query', description: 'deep schema tool', sideEffect: 'readonly',
              inputSchema: {
                type: 'object',
                properties: { q: { type: 'string' }, limit: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
                required: ['q'],
              },
            },
            { name: 'ts_plain' },
          ] },
        }
      }
      throw new Error('unknown method ' + req.method)
    },
    alive() { return true },
    close() {},
  }
}

test('McpGateway: tools/list inputSchema 原样捕获进能力矩阵（不丢弃）', async () => {
  const gw = new McpGateway()
  await gw.register({ serverId: 'ts1', transport: schemaTransport() })
  const matrix = gw.listTools()
  const q = matrix.find(t => t.name === 'ts_query')!
  assert.ok(q.inputSchema && typeof q.inputSchema === 'object', 'inputSchema 已捕获')
  const plain = matrix.find(t => t.name === 'ts_plain')!
  assert.equal(plain.inputSchema, undefined, '未声明 inputSchema 保持 undefined（渲染层落 unknown）')
})
