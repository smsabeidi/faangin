// esbuild injects these lexical bindings into bundled CommonJS dependencies such as ws.
// Hosted Supabase ESM does not guarantee Node's ambient globals.
export { Buffer } from 'node:buffer'
export { default as process } from 'node:process'
