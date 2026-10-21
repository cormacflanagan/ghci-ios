// Bundles src/editor.js (CodeMirror) into web/vendor/editor.js.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/editor.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['safari15'],
  outfile: 'web/vendor/editor.js',
  legalComments: 'eof',
});
console.log('wrote web/vendor/editor.js');
