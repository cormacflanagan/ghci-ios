// Bundles src/editor.js (CodeMirror) and src/share.js (QR codes) into web/vendor/.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/editor.js', 'src/share.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['safari15'],
  outdir: 'web/vendor',
  legalComments: 'eof',
});
console.log('wrote web/vendor/editor.js, web/vendor/share.js');
