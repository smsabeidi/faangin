import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    build: {
      rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.js' } }
    }
  },
  renderer: {
    plugins: [react(), {
      name: 'faangin-production-csp',
      apply: 'build',
      transformIndexHtml(html) {
        if (!html.includes('<div id="root">')) return
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" }, injectTo: 'head-prepend' }]
      }
    }],
    build: { assetsInlineLimit: 0, rollupOptions: { input: { index: resolve('src/renderer/index.html'), capture: resolve('src/renderer/capture.html'), document: resolve('src/renderer/document.html') } } }
  }
})
