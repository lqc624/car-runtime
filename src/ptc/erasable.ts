/**
 * T-2 · erasable-only TS 静态检查（M3-S14 双挂点：loader 提交链 + run_code 入口）
 *
 * 口径（M3系统设计增补 T-2 / dsh 源码一手口径 code-runtime-worker-thread/src/index.ts:306-308）：
 *  - PTC 程序体与插件提交链只接受 erasable TS（Node type-stripping 可直接剥离的语法）——
 *    禁止 enum / namespace / module / 构造器参数属性 / import=require 等需转换的语法；
 *  - 双挂点保证「无 worker 即无执行，漏检面 = 0」：loader 在插件装载时检查源码，
 *    run_code 在 worker 启动前检查程序体——两处调用同一函数（单一事实源）。
 */

/** erasable 语法黑名单（启发式正则；完整 AST 检查随 jiti 实装升级为语法级） */
const NON_ERASABLE: Array<{ name: string; re: RegExp }> = [
  { name: 'enum 声明', re: /(?:^|\n)\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/ },
  { name: 'namespace 声明', re: /(?:^|\n)\s*(?:export\s+)?namespace\s+[A-Za-z_$]/ },
  { name: 'module 声明', re: /(?:^|\n)\s*(?:export\s+)?module\s+[A-Za-z_$"'`]/ },
  { name: '构造器参数属性', re: /constructor\s*\(\s*(?:public|private|protected|readonly)\s+[A-Za-z_$]/ },
  { name: 'import=require', re: /import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/ },
  { name: 'export=require', re: /export\s*=\s*/ },
  { name: '装饰器（实验性，非 erasable）', re: /@\s*[A-Za-z_$][\w$]*\s*\(/ },
]

/** erasable-only 检查：违规 = 显式报错（冲突链定位到语法名；v1 为启发式，行号随 AST 升级） */
export function checkErasableOnly(code: string): { ok: boolean; violation?: string } {
  for (const { name, re } of NON_ERASABLE) {
    if (re.test(code)) return { ok: false, violation: `non-erasable TS: ${name}（PTC 程序体与插件提交链仅接受 erasable TS，见 M3系统设计增补 T-2）` }
  }
  return { ok: true }
}
