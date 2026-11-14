import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * 子工程独立构建配置。
 *
 * - `base: './'`：产物使用相对路径，可部署在任意子路径，不依赖 `/webMap/` 前缀。
 * - 别名 `@` 指向子工程自身的 `src`，与根工程同名但互不影响。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5175,
    strictPort: true,
  },
  preview: {
    port: 4175,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
