/**
 * Build the publishable package: one esbuild pass bundles the CLI and the server (with @mandate/doc, @mandate/shared
 * and every pure-JS dependency inlined; shared code split into chunks), then the built web UI is copied to dist/web.
 * Native modules stay external and are real dependencies (prebuilt binaries: better-sqlite3 prebuilds, sqlite-vec
 * and es-git platform packages), so installs never need a compiler.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const web = path.resolve(root, '../web/dist');
if (!existsSync(path.join(web, 'index.html'))) {
  console.error(`missing ${web}/index.html: build the web UI first (npm run build -w @mandate/web)`);
  process.exit(1);
}
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: { cli: path.join(root, 'src/cli.ts'), server: path.resolve(root, '../server/src/index.ts') },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  chunkNames: 'chunk-[hash]',
  external: ['better-sqlite3', 'sqlite-vec', 'es-git', '@huggingface/transformers'],
  // CJS dependencies (fastify, …) bundled into ESM need require / __dirname.
  banner: {
    js: [
      "import { createRequire as __mandateCreateRequire } from 'node:module';",
      "import { fileURLToPath as __mandateFileURLToPath } from 'node:url';",
      "import { dirname as __mandateDirname } from 'node:path';",
      'const require = __mandateCreateRequire(import.meta.url);',
      'const __filename = __mandateFileURLToPath(import.meta.url);',
      'const __dirname = __mandateDirname(__filename);',
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'warning',
  minifySyntax: true,
});

// Shebang for the bin.
const { readFileSync, writeFileSync } = await import('node:fs');
const cli = path.join(dist, 'cli.js');
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, 'utf8')}`);
chmodSync(cli, 0o755);

cpSync(web, path.join(dist, 'web'), { recursive: true });
console.log(`built ${path.relative(process.cwd(), dist)} (cli.js, server.js, web/)`);
