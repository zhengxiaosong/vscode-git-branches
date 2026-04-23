const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const ctx = esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  outfile: 'out/extension.js',
  sourcemap: true,
});

ctx.then(async (c) => {
  if (watch) {
    await c.watch();
    console.log('Watching for changes...');
  } else {
    await c.rebuild();
    await c.dispose();
  }
}).catch(() => process.exit(1));
