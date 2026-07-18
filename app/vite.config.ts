import { defineConfig } from 'vite'

export default defineConfig({
  // Относительные пути ассетов: сборка работает и на поддиректории GitHub
  // Pages (/Franke/), и внутри Tauri (tauri://localhost).
  base: './',
  server: {
    port: 5173,
    strictPort: true
  },
  clearScreen: false
})
