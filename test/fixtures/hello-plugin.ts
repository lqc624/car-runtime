export const manifest = { name: 'hello-plugin', version: '1.0.0' }
export default function apply(api: unknown) {
  const a = api as { registerTool: (t: unknown) => void }
  a.registerTool({ name: 'hello', run: async () => 'world' })
}
