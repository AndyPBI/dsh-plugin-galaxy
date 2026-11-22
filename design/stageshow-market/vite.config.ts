import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The composition lives in the repo; the kit it renders stays in the skill
// install and is imported read-only. Nothing is written back into the skill.
const skill = resolve(process.env.HOME ?? '', '.agents/skills/stageshow')

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@kit': resolve(skill, 'kit') },
  },
  server: { host: '127.0.0.1', port: 5211, strictPort: true, fs: { allow: ['.', skill] } },
})
