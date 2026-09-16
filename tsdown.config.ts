/**
 * Browser client bundle for the Plugin Galaxy plugin, mirroring the DeepSeek
 * Harness client preset for an external package: a closure-factory artifact
 * that calls window.__ModuleLoader__.load({ id, factory }) and resolves
 * externals through the injected require (loader module table). CSS Modules
 * compile via lightningcss inside the bundle: importing `x.module.css` yields
 * the hashed class map, and the css text auto-injects a <style data-plugin>
 * tag at factory execution (the loader removes plugin-owned tags on unload).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const id = 'dsh-plugin-galaxy'

/**
 * Externals resolved from the loader module table at runtime. Only the
 * platform seed entries this bundle actually requires; everything else
 * inlines.
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 * The suffix matters: tsdown's guard matches ids ending in `.css`, so the
 * virtual id must not.
 *
 * The id carries a WORKSPACE-RELATIVE path, not the absolute one it resolves
 * from: the bundler writes the id into a `//#region` comment, and an absolute
 * path there would publish the build machine's home directory inside
 * `client/client.js`.
 */
const CSS_VIRTUAL_PREFIX = '\0galaxy-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
/** Virtual id → absolute file, so `load()` never has to guess the root. */
const CSS_FILES = new Map<string, string>()

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      const virtualId = CSS_VIRTUAL_PREFIX + relative(process.cwd(), abs).split('\\').join('/') + CSS_VIRTUAL_SUFFIX
      CSS_FILES.set(virtualId, abs)
      return virtualId
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      const fileId = CSS_FILES.get(virtualId)
      if (fileId === undefined) return null
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: relative(process.cwd(), fileId).split('\\').join('/'),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
        targets: { chrome: 90 << 16, firefox: 100 << 16, safari: 13 << 16, edge: 90 << 16 },
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
