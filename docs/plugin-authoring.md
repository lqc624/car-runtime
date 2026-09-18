# CAR 插件作者指南（M6 DX）

面向插件作者的写码红线与热重载实操。本文所述行为均为实测口径（POC-2 + S1–S3 红线），不是"建议"。

## 插件文件形态

CAR 免编译加载插件（Node type-stripping 载体），一个插件 = 一个 `.ts` 文件：

```ts
// my-plugin.ts
export const manifest = { name: 'my-plugin', version: '1.2.3' }  // 命名导出，可省略（省略则按文件名合成）

export default function apply(api) {
  api.registerTool({ name: 'hello', run: async () => 'world' })
  api.registerCommand({ name: 'hi', run: async (args) => console.log('hi', args) })
}
```

- `manifest.version` 必须是**精确 semver**（`x.y.z`），版本区间仅用于 peer 校验；
- `manifest.peers` 声明 peer 约束：`{ peer, range, optional? }`；冲突即加载期硬报错，
  放宽需 `manifest.peerPolicyOverride = { relaxed: true, reason: '…' }`（reason 必填，审计留痕）；
- 插件源码只接受 **erasable TS**（禁 enum/namespace/装饰器等需转换的语法，loader 挂点显式拒绝）。

## 写码红线（违反 = 运行期错位，已实证）

### 1. invalidate 必须包裹插件 fiber 作用域 ctx，而非根 ctx

POC-2 实证：把根 ctx 透传给插件工厂会导致 effect 注册到错误 fiber——**effect 注册错位、
dispose 回卷不到**。热重载失效旧实例时，只能失效插件自身作用域的 ctx（`api` 句柄），
根 ctx 与其它插件不受影响。插件作者视角：不要保存/传递宿主根 ctx，只使用 `apply(api)` 收到的 `api`。

### 2. apply 不能返回非 disposer 对象

cordis 语义：`apply` 返回值 = effect body。CAR 内核同步约定——`apply` 同步完成注册，
需要异步初始化请走 `ctx.effect(async () => { … })`。返回 Promise/普通对象 = 加载期显式报错。

### 3. getRegisteredTools 在 bindCore 前调用即抛 CAR-STUB

Stub 语义分层（红线 5）：
- **注册类动作**（`registerTool`/`registerCommand`）Stub 期始终可用——收集待注册项，`bindCore` 后冲刷；
- **能力查询**（`getRegisteredTools`）依赖宿主绑定，bindCore 前一调用即抛
  `CAR-STUB`——用启动期显式失败换运行期时序正确。

### 4. 旧 ctx 访问抛 CAR-INVALIDATED

`car reload`（或 `ReloadManager.reload()`）后，旧插件实例的 `api` 句柄**任何属性访问**都抛
`CAR-INVALIDATED: … (旧上下文已失效，请重新加载)`。持有旧句柄的闭包不会静默失效——显式报错定位。

## 热重载实操

```bash
car reload my-plugin.ts      # 单文件
car reload ./plugins/        # 目录（扫描 *.ts，排除 .d.ts/.spec.ts）
```

五阶段流水线（任一 FAIL 短路，后续 SKIPPED，FAIL 附文件+原因定位）：

| 阶段 | 内容 | 典型 FAIL |
|------|------|-----------|
| discover | 扫描插件文件；git 直载来源产生 CAR-W-GIT-DIRECT 告警（E-03） | 路径不存在 / 无 .ts |
| parse | 读 manifest（命名导出，缺失按文件名合成）+ parseManifest | version 非精确 semver |
| validate | peer 约束校验，冲突链进报告 `conflicts` | peer 区间不符且未豁免 |
| topo | peer 依赖边 Kahn 拓扑排序 | 依赖环（CAR-E-DEPCYCLE） |
| register | mountPlugin 逐个装配（拓扑序） | 工厂非默认导出 / erasable 违规 / 重名 |

成功输出含 `installId`、`startedTime`、`durationMs`（QS-05 基线 P95 ≤ 800ms）与 `warnings`。

程序化热重载：

```ts
import { ReloadManager } from '../src/load/report.ts'
const mgr = new ReloadManager()
const { report, plugins } = await mgr.reload('./plugins/')  // epoch 每次 +1 击穿模块缓存
```

## peer 冲突链示例

```
[validate] FAIL — ./plugins/b.ts: peer dep-p@^2.0.0 required but 1.0.0 installed (path: manifest.peers)
```

冲突链定位三要素：**文件**（谁声明的）、**区间 vs 实际版本**、**依赖路径**。按此修版本或走豁免流程。
