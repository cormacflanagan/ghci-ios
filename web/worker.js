// Runs the MicroHs REPL (compiled to WebAssembly) off the main thread.
// The UI talks to it with messages:
//   in:  {type:'input', text}        keystrokes for the REPL / running program
//        {type:'write', path, text}  write a file into the virtual file system
//        {type:'remove', path}       delete a file from the virtual file system
//        {type:'depth', n}           limit on nested evaluation (see app.js)
//   out: {type:'out', bytes}         terminal output (UTF-8 bytes)
//        {type:'abort', reason}      the runtime died; the UI starts a new worker

'use strict';

const HOME = '/home/web_user';
// worker.js?small runs with a small heap; used to probe the stack limit.
const SMALL = self.location.search.includes('small');
const RC = ':set prompt=λ> \n';

let pending = [];
let flushTimer = null;

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const bytes = new Uint8Array(pending);
  pending = [];
  postMessage({ type: 'out', bytes }, [bytes.buffer]);
}

function emit(byte) {
  if (byte === null || byte === undefined) return;
  pending.push(byte & 0xff);
  if (pending.length > 8192) flush();
  else if (flushTimer === null) flushTimer = setTimeout(flush, 15);
}

function mkdirs(path) {
  const parts = path.split('/').slice(0, -1);
  let cur = '';
  for (const p of parts) {
    if (!p) continue;
    cur += '/' + p;
    try { Module.FS.mkdir(cur); } catch (e) { /* exists */ }
  }
}

const inputQueue = [];
function sendInput(text) {
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) Module._set_input_char(b);
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'input') {
      if (Module._set_input_char) sendInput(m.text);
      else inputQueue.push(m.text);
    } else if (m.type === 'write') {
      const path = HOME + '/' + m.path;
      mkdirs(path);
      Module.FS.writeFile(path, m.text);
    } else if (m.type === 'depth') {
      Module._set_max_c_depth(m.n);
    } else if (m.type === 'remove') {
      try { Module.FS.unlink(HOME + '/' + m.path); } catch (e) { /* missing */ }
    }
  } catch (e) {
    postMessage({ type: 'log', text: String(e) });
  }
};

function fatal(reason) {
  flush();
  postMessage({ type: 'abort', reason: String(reason) + (reason && reason.stack ? '\n' + reason.stack : '') });
}

self.Module = {
  arguments: SMALL ? ['+RTS', '-H6M', '-RTS'] : [],
  noExitRuntime: true,
  locateFile: (p) => 'mhs/' + p,
  preRun: [function () {
    Module.FS.init(() => null, emit, emit);
    try { Module.FS.mkdirTree(HOME); } catch (e) { /* exists */ }
    Module.FS.chdir(HOME);
    Module.FS.writeFile(HOME + '/.mhsi_rc', RC);
  }],
  onRuntimeInitialized() {
    postMessage({ type: 'ready' });
    for (const t of inputQueue.splice(0)) sendInput(t);
  },
  print: () => {},
  printErr: (t) => postMessage({ type: 'log', text: t }),
  onAbort: fatal,
  quit: (status) => fatal('exit ' + status),
};

self.addEventListener('error', (e) => { e.preventDefault(); fatal(e.error || e.message || 'error'); });
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fatal(e.reason || 'error'); });

importScripts('mhs/mhs.js');
