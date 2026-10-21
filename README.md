# Haskell REPL for iPad

An offline web app (PWA) for editing small Haskell files and running them in a
GHCi-style REPL on an iPad, with large text for projecting.

The interpreter is [MicroHs](https://github.com/augustss/MicroHs) compiled to
WebAssembly. It runs inside the app, with no server. **It is not GHC.** It
covers Haskell 2010 plus common extensions and a GHC-like `base`, but error
messages differ from GHC's and some GHC-only features are missing.

## Install on the iPad

1. Host the `web/` folder over HTTPS. The included workflow publishes it to
   GitHub Pages: in the repo, go to *Settings → Pages → Source: GitHub Actions*,
   then push to `main`/`master` or run the workflow by hand.
2. Open the URL in Safari, then *Share → Add to Home Screen*.
3. Open it from the Home Screen once while online. After that it works offline.

Always use the Home Screen app. Safari tabs keep their own separate file storage.

## Using it

- **Load** (⌘↵) works like `:load` for the file in the editor. `:l Name` and
  `:r` also work in the REPL.
- Files without a `module` header work the same way they do in GHCi. Tap an
  error line to jump to it in the editor.
- **Stop** (Ctrl-C) interrupts a running expression. If the interpreter does
  not respond, it is restarted and the loaded file is loaded again.
- **Files**: files are saved inside the app automatically. *Open from device*
  imports `.hs` files from the Files app. *Save copy to device* exports the
  current file through the share sheet (Files, AirDrop, Mail).
- A− / A+ (⌘− / ⌘+) change the text size. ◐ switches between light and dark.
  Code / Both / REPL choose the layout.
- The symbol bar above the keyboard inserts `->`, `<-`, `::`, `\`, `|` and so
  on. ↑/↓ step through REPL history.
- iPad "smart punctuation" (curly quotes, em dashes) is turned back into
  ASCII automatically.

## Robustness

- The interpreter runs in a Web Worker, so a runaway computation never freezes
  the UI. If the interpreter dies, the app restarts it automatically.
- Stack overflow and heap exhaustion raise Haskell exceptions
  (`*** Exception: stack overflow`) and do not kill the interpreter.
- Browsers give WebAssembly a small native stack, so deep non-tail recursion
  (for example `foldr (+) 0 [1..10000]`) runs out sooner than in GHC. On first
  launch, the app measures the device's limit in a background worker. If a
  native overflow still happens, the app lowers the limit.

## Development

```
npm install
npm run build       # bundle CodeMirror into web/vendor/editor.js
npm run serve       # http://localhost:8000
npm test            # end-to-end test in Chromium (set CHROMIUM=/path/to/chrome if needed)
```

`scripts/build-wasm.sh` rebuilds `web/mhs/mhs.{js,wasm}` from a pinned MicroHs
commit with `patches/microhs-web.patch`. It needs Emscripten (`emcc`) on PATH.
The patch:
- routes program stdin through the web input queue
- turns stack and heap overflow into exceptions
- bounds nested evaluation depth
- keeps `setjmp` out of the evaluator's hot path
- makes `:clear` keep the embedded base package

After changing app files, bump `CACHE` in `web/sw.js` so installed apps pick up
the new version.
