import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const emptyModulePlugin = () => ({
  name: 'empty-module-plugin',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (['fs', 'crypto', 'path'].includes(id)) {
      return id;
    }
  },
  load(id: string) {
    if (['fs', 'crypto', 'path'].includes(id)) {
      return 'export default {}';
    }
  }
});

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), emptyModulePlugin()]
})
