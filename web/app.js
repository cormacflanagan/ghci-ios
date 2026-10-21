import { createEditor, unsmart } from './vendor/editor.js';
import { Repl, probeDepth } from './repl.js';
import { makeFragment, readFragment, qrSvg } from './vendor/share.js';

const APP_VERSION = '1.0.0';
// Identifies the interpreter build; the stack calibration is redone when it changes.
const ENGINE = 'mhs-0.16.11.0-web1';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
};

const SAMPLE = `-- Welcome!  Edit this file, then tap Load (or press ⌘↵).
-- Then try these in the REPL:
--   double 21
--   map double [1..10]
--   :t quicksort
--   quicksort [3,1,4,1,5,9,2,6]
--   area (Circle 1)

double :: Int -> Int
double x = 2 * x

quicksort :: Ord a => [a] -> [a]
quicksort []     = []
quicksort (p:xs) = quicksort [x | x <- xs, x < p]
                ++ [p]
                ++ quicksort [x | x <- xs, x >= p]

data Shape = Circle Double | Rect Double Double
  deriving Show

area :: Shape -> Double
area (Circle r) = pi * r * r
area (Rect w h) = w * h
`;

let files = store.get('ghci.files', null);
if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
  files = { 'Intro.hs': SAMPLE };
}
let current = store.get('ghci.current', null);
if (!files[current]) current = Object.keys(files).sort()[0];

const settings = Object.assign(
  { font: 22, theme: 'light', layout: 'split' },
  store.get('ghci.settings', {}),
);
let history = store.get('ghci.history', []);
if (!Array.isArray(history)) history = [];

let saveTimer = null;
let dirty = false;

function saveFiles() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (editor) files[current] = editor.getText();
  const ok = store.set('ghci.files', files) && store.set('ghci.current', current);
  dirty = false;
  $('#save-state').textContent = ok ? 'Saved' : 'NOT SAVED';
  if (!ok) toast('Could not save: storage is full or unavailable. Use "Save copy to device".');
  return ok;
}

function scheduleSave() {
  dirty = true;
  $('#save-state').textContent = 'Editing…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFiles, 400);
}

// ---------------------------------------------------------------- modules

const MODULE_RE = /^module\s+([A-Z][\w.']*)/m;

function baseName(name) {
  return name.replace(/\.[^.]*$/, '');
}

// Turns any file name into a valid Haskell module file name, e.g. "lab 2.hs" -> "Lab2.hs".
function cleanName(name) {
  let b = baseName(String(name).trim()).replace(/[^A-Za-z0-9_']/g, '');
  if (!b) b = 'Untitled';
  if (/^[0-9_']/.test(b)) b = 'M' + b;
  return b[0].toUpperCase() + b.slice(1) + '.hs';
}

// What the interpreter sees for a file: its module name, path, and text.
// A file without a "module" header gets one named after the file (like
// GHCi does for Main), inserted after any leading pragmas; `offset` is the
// number of lines added, so error locations can be shifted back.
function compiled(name) {
  const text = files[name] || '';
  const m = text.match(MODULE_RE);
  if (m) return { module: m[1], path: m[1].replace(/\./g, '/') + '.hs', text, offset: 0, at: 0 };
  const mod = baseName(name);
  const lines = text.split('\n');
  let at = 0;
  while (at < lines.length && /^\s*(\{-#.*#-\}\s*)?$/.test(lines[at]) && lines[at].includes('{-#')) at++;
  lines.splice(at, 0, `module ${mod} where`);
  return { module: mod, path: mod + '.hs', text: lines.join('\n'), offset: 1, at };
}

let fsMap = new Map();   // interpreter path -> {name, offset, at}

function syncFiles() {
  if (editor && files[current] !== editor.getText()) {
    files[current] = editor.getText();
    scheduleSave();
  }
  const next = new Map();
  for (const name of Object.keys(files)) {
    const c = compiled(name);
    next.set(c.path, { name, offset: c.offset, at: c.at });
    repl.writeFile(c.path, c.text);
  }
  for (const path of fsMap.keys()) if (!next.has(path)) repl.removeFile(path);
  fsMap = next;
}

// ---------------------------------------------------------------- output

const outEl = $('#output');
let curLine = null;
let inError = false;
let pending = [];
let flushQueued = false;
const MAX_LINES = 4000;
const MAX_LINE_CHARS = 20000;

function write(text, kind) {
  pending.push([text, kind]);
  if (!flushQueued) {
    flushQueued = true;
    requestAnimationFrame(flushOutput);
  }
}

function flushOutput() {
  flushQueued = false;
  const items = pending;
  pending = [];
  const stick = outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 60;
  for (const [text, kind] of items) writeNow(text, kind);
  while (outEl.childElementCount > MAX_LINES) outEl.firstElementChild.remove();
  if (stick || items.some(([, k]) => k === 'cmd')) outEl.scrollTop = outEl.scrollHeight;
}

function writeNow(text, kind) {
  if (kind !== 'out' && curLine && curLine.textContent) finishLine();
  const parts = text.split('\n');
  parts.forEach((part, i) => {
    if (part) {
      if (curLine && curLine.dataset.kind !== kind) finishLine();
      if (!curLine) {
        curLine = document.createElement('div');
        curLine.className = 'line ' + kind;
        curLine.dataset.kind = kind;
        outEl.appendChild(curLine);
      }
      curLine.textContent += part;
      if (curLine.textContent.length > MAX_LINE_CHARS) finishLine();
    }
    if (i < parts.length - 1) {
      if (!curLine) {
        curLine = document.createElement('div');
        curLine.className = 'line ' + kind;
        curLine.dataset.kind = kind;
        outEl.appendChild(curLine);
      }
      finishLine();
    }
  });
}

const LOC_RE = /(?:\.\/)?([A-Za-z][\w/.']*\.hs)(?:"?,|:)(\d+):(\d+)/;
const ERR_RE = /^\*\*\* Exception|\berror\b|^no location:/;

function finishLine() {
  const el = curLine;
  curLine = null;
  if (!el || el.dataset.kind !== 'out') return;
  let text = el.textContent;
  const loc = text.match(LOC_RE);
  if (loc && fsMap.has(loc[1])) {
    const f = fsMap.get(loc[1]);
    let line = Number(loc[2]);
    if (f.offset && line > f.at) line -= f.offset;
    const col = Number(loc[3]);
    text = text.replace(loc[0], `${f.name}:${line}:${col}`);
    el.textContent = text;
    el.classList.add('loc');
    el.title = 'Show in editor';
    el.addEventListener('click', () => showLocation(f.name, line, col));
  }
  if (ERR_RE.test(text)) {
    el.classList.add('err');
    inError = true;
  } else if (inError && /^\s/.test(text)) {
    el.classList.add('err');
  } else {
    inError = false;
  }
}

function showLocation(name, line, col) {
  if (!files[name]) return;
  if (name !== current) openFile(name);
  if (settings.layout === 'console') setLayout('split');
  editor.gotoLine(line, col);
}

function clearOutput() {
  outEl.textContent = '';
  curLine = null;
  inError = false;
}

// ---------------------------------------------------------------- REPL

let loaded = null;   // file name last loaded with :load
let announceLoad = false;   // show the result of the load done at startup
const savedDepth = store.get('ghci.depth', null);

const repl = new Repl({
  output: write,
  state: setStatus,
  started() {
    syncFiles();
    if (loaded && files[loaded]) loadFile(loaded, { quiet: !announceLoad });
    announceLoad = false;
    maybeCalibrate();
  },
  crashed(reason) {
    let msg = 'The interpreter stopped unexpectedly and is restarting.';
    if (/call stack|too much recursion/i.test(reason)) {
      const d = Math.max(100, Math.floor(repl.depth * 0.6));
      store.set('ghci.depth', { engine: ENGINE, depth: d, calibrated: true });
      repl.depth = d;
      msg = 'Stack overflow: the recursion was too deep for this device. The interpreter is restarting.';
    }
    write(msg + (loaded ? ` ${loaded} will be loaded again.` : '') + '\n', 'sys');
  },
  prompt() {
    updatePrompt();
  },
}, { depth: savedDepth && savedDepth.engine === ENGINE ? savedDepth.depth : 800 });

function setStatus(s) {
  const el = $('#status');
  const labels = {
    starting: 'Starting Haskell…', ready: 'Ready', busy: 'Running…',
    restarting: 'Restarting…', failed: 'Not running',
  };
  el.textContent = labels[s] || s;
  el.className = 'status ' + s;
  $('#stop-btn').disabled = s !== 'busy';
  updatePrompt();
}

function updatePrompt() {
  const p = $('#prompt');
  const running = repl.state === 'busy';
  p.textContent = running ? 'stdin>' : 'λ>';
  p.classList.toggle('busy', repl.state !== 'ready' && !running);
}

function findFile(arg) {
  arg = arg.trim().replace(/^"(.*)"$/, '$1');
  if (!arg) return current;
  if (files[arg]) return arg;
  if (files[arg + '.hs']) return arg + '.hs';
  for (const name of Object.keys(files)) {
    if (compiled(name).module === arg || name.toLowerCase() === arg.toLowerCase()) return name;
  }
  return null;
}

// Like GHCi's :load: forget everything and load one file (and what it imports).
function loadFile(name, { quiet = false } = {}) {
  if (!repl.started) {
    loaded = name;   // loaded automatically once the interpreter is up
    if (!quiet) {
      announceLoad = true;
      write(`${name} will be loaded when the interpreter has started.\n`, 'sys');
    }
    return;
  }
  if (repl.busy) {
    toast('Still running. Press Stop first.');
    return;
  }
  if (name === current) saveFiles();
  syncFiles();
  const mod = compiled(name).module;
  if (!quiet) write('λ> :load ' + name + '\n', 'cmd');
  // :clear forgets definitions and imports; :reload then drops compiled
  // modules whose files changed, so the import below sees the new text.
  repl.enqueue({ line: ':clear', silent: true });
  repl.enqueue({ line: ':reload', silent: true });
  repl.enqueue({
    line: 'import ' + mod,
    echo: false,
    filter: (l) => !/^(loaded \S+ \(|Loading package )/.test(l),
    onDone(output) {
      const errors = output.split('\n').filter((l) => l && !/^(loaded \S+ \(|Loading package )/.test(l));
      if (errors.length === 0) {
        loaded = name;
        if (!quiet) write(`Ok, ${mod} loaded.\n`, 'ok');
      } else {
        loaded = null;
        write('Failed to load ' + name + '.\n', 'err');
      }
    },
  });
}

function runLine(raw) {
  const line = unsmart(raw).replace(/\s+$/, '');
  if (repl.state === 'busy' && repl.atPrompt === false && !repl.current?.silent) {
    // A program is running and reading input.
    repl.sendStdin(line);
    return;
  }
  if (line.trim()) {
    if (history[history.length - 1] !== line) history.push(line);
    if (history.length > 200) history = history.slice(-200);
    store.set('ghci.history', history);
  }
  histPos = history.length;

  if (repl.state !== 'ready') {
    if (repl.state === 'busy') toast('Still running. Press Stop first.');
    else toast('The interpreter is still starting…');
    return false;
  }
  const t = line.trim();
  if (!t) {
    write('λ>\n', 'cmd');
    return;
  }
  if (t.startsWith(':!')) {
    write('λ> ' + t + '\n', 'cmd');
    write('Shell commands are not available.\n', 'sys');
    return;
  }
  const m = t.match(/^:(\w+)\s*(.*)$/);
  if (m) {
    const [, c, arg] = m;
    if ('load'.startsWith(c)) {
      const name = findFile(arg);
      if (name) loadFile(name);
      else { write('λ> ' + t + '\n', 'cmd'); write(`No file called ${arg}.\n`, 'err'); }
      return;
    }
    if ('reload'.startsWith(c)) {
      write('λ> ' + t + '\n', 'cmd');
      loadFile(loaded || current, { quiet: false });
      return;
    }
    if ('quit'.startsWith(c)) {
      write('λ> ' + t + '\n', 'cmd');
      write('Use Restart to start a fresh interpreter.\n', 'sys');
      return;
    }
    if ('edit'.startsWith(c)) {
      write('λ> ' + t + '\n', 'cmd');
      write('Edit files in the editor pane.\n', 'sys');
      return;
    }
    if (c === 'cd') {
      write('λ> ' + t + '\n', 'cmd');
      write(':cd is not available.\n', 'sys');
      return;
    }
  }
  syncFiles();
  repl.enqueue({ line });
}

// ---------------------------------------------------------------- stack calibration

let calibrating = false;

async function maybeCalibrate() {
  const saved = store.get('ghci.depth', null);
  if (calibrating || (saved && saved.engine === ENGINE && saved.calibrated)) return;
  calibrating = true;
  try {
    // Find roughly how deep evaluation can nest before this browser's stack
    // runs out, in a separate small worker, then use a safe fraction of it.
    let ok = 0;
    let bad = 0;
    for (let d = 1000; d <= 64000; d *= 2) {
      if (await probeDepth(d)) ok = d; else { bad = d; break; }
    }
    if (ok && bad) {
      const mid = Math.round(Math.sqrt(ok * bad));
      if (await probeDepth(mid)) ok = mid;
    }
    if (!ok) {
      for (const d of [500, 250]) if (await probeDepth(d)) { ok = d; break; }
    }
    const depth = Math.max(100, Math.floor((ok || 160) * 0.6));
    store.set('ghci.depth', { engine: ENGINE, depth, calibrated: true, max: ok });
    repl.setDepth(depth);
  } finally {
    calibrating = false;
  }
}

// ---------------------------------------------------------------- editor & files

let editor = null;

function openFile(name) {
  if (editor && files[current] !== undefined) files[current] = editor.getText();
  current = name;
  editor.setText(files[name] || '');
  $('#file-name').textContent = name;
  saveFiles();
  renderFileList();
}

function newFile() {
  const raw = prompt('Name of the new file (e.g. Lists.hs):', '');
  if (raw === null) return;
  const name = cleanName(raw);
  if (files[name] !== undefined) {
    toast(name + ' already exists.');
    openFile(name);
    return;
  }
  files[name] = `module ${baseName(name)} where\n\n`;
  openFile(name);
  closeSheet();
  editor.focus();
}

function renameFile(name) {
  const raw = prompt('Rename ' + name + ' to:', name);
  if (raw === null) return;
  const to = cleanName(raw);
  if (to === name) return;
  if (files[to] !== undefined) {
    toast(to + ' already exists.');
    return;
  }
  if (name === current) files[current] = editor.getText();
  let text = files[name];
  // Keep the module header in step with the file name.
  const m = text.match(MODULE_RE);
  if (m && m[1] === baseName(name)) text = text.replace(MODULE_RE, `module ${baseName(to)}`);
  delete files[name];
  files[to] = text;
  if (loaded === name) loaded = to;
  if (name === current) {
    current = to;
    editor.setText(text);
    $('#file-name').textContent = to;
  }
  saveFiles();
  renderFileList();
}

function deleteFile(name) {
  if (!confirm('Delete ' + name + '? This cannot be undone.')) return;
  delete files[name];
  if (loaded === name) loaded = null;
  if (Object.keys(files).length === 0) files['Main.hs'] = 'module Main where\n\n';
  if (name === current) openFile(Object.keys(files).sort()[0]);
  saveFiles();
  renderFileList();
}

function renderFileList() {
  const ul = $('#file-list');
  ul.textContent = '';
  for (const name of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    const li = document.createElement('li');
    if (name === current) li.className = 'current';
    const open = document.createElement('button');
    open.className = 'open';
    open.textContent = name;
    open.addEventListener('click', () => { openFile(name); closeSheet(); });
    const ren = document.createElement('button');
    ren.className = 'btn small';
    ren.textContent = 'Rename';
    ren.addEventListener('click', () => renameFile(name));
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteFile(name));
    li.append(open, ren, del);
    ul.appendChild(li);
  }
}

function openSheet() {
  renderFileList();
  $('#files-sheet').hidden = false;
}

function closeSheet() {
  $('#files-sheet').hidden = true;
}

async function exportFile() {
  saveFiles();
  const name = current;
  const blob = new Blob([files[name]], { type: 'text/plain' });
  try {
    const file = new File([blob], name, { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // the user closed the share sheet
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------------------------------------------------------- share links

let shareUrl = '';

async function shareFile() {
  saveFiles();
  const name = current;
  shareUrl = location.origin + location.pathname + await makeFragment(name, files[name]);
  $('#share-title').textContent = name;
  const svg = qrSvg(shareUrl);
  const qr = $('#qr');
  if (svg) {
    qr.innerHTML = svg;
    $('#share-hint').textContent = 'Scan with a phone or tablet camera to open a copy of this file in the Haskell REPL.';
  } else {
    qr.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'too-big';
    p.textContent = `${name} is too large for a QR code. Copy or send the link instead.`;
    qr.appendChild(p);
    $('#share-hint').textContent = '';
  }
  $('#share-sheet').hidden = false;
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl);
    toast('Link copied');
  } catch (e) {
    prompt('Copy this link:', shareUrl);
  }
}

async function sendLink() {
  try {
    if (navigator.share) {
      await navigator.share({ title: current, url: shareUrl });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  copyLink();
}

function uniqueName(name) {
  const b = baseName(name);
  let i = 2;
  while (files[`${b}${i}.hs`] !== undefined) i++;
  return `${b}${i}.hs`;
}

// Opens a file arriving in a share link (#f=...), then loads it.
async function receiveShared() {
  if (!location.hash.startsWith('#f=')) return;
  let shared = null;
  try {
    shared = await readFragment(location.hash);
  } catch (e) {
    toast('Could not open the shared file: ' + e.message);
  }
  window.history.replaceState(null, '', location.pathname + location.search);
  if (!shared) return;
  let name = cleanName(shared.name);
  const text = shared.text.replace(/\r\n?/g, '\n');
  if (files[name] !== undefined && files[name] !== text && !(name === current && editor.getText() === text)) {
    if (!confirm(`Replace your ${name} with the shared version?\n\nCancel keeps yours and saves the shared one as a new file.`)) {
      name = uniqueName(name);
    }
  }
  files[name] = text;
  if (name === current) editor.setText(text);
  openFile(name);
  closeSheet();
  $('#share-sheet').hidden = true;
  toast('Opened shared file ' + name);
  loadFile(name);
}

async function importFiles(list) {
  let last = null;
  for (const f of Array.from(list)) {
    if (f.size > 2_000_000) {
      toast(f.name + ' is too large.');
      continue;
    }
    let text;
    try {
      text = (await f.text()).replace(/\r\n?/g, '\n');
    } catch (e) {
      toast('Could not read ' + f.name);
      continue;
    }
    const name = cleanName(f.name);
    if (files[name] !== undefined && files[name] !== text && !confirm(`Replace the existing ${name}?`)) continue;
    if (name === current) editor.setText(text);
    files[name] = text;
    last = name;
  }
  if (last) {
    openFile(last);
    closeSheet();
    toast('Opened ' + last);
  }
}

// ---------------------------------------------------------------- settings

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--fs', settings.font + 'px');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = settings.theme === 'dark' ? '#1e1e21' : '#ffffff';
  if (editor) editor.setFontSize(settings.font);
  $('#panes').dataset.layout = settings.layout;
  for (const b of document.querySelectorAll('.segmented button')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === settings.layout));
  }
  store.set('ghci.settings', settings);
}

function setFont(delta) {
  settings.font = Math.max(12, Math.min(56, settings.font + delta));
  applySettings();
}

function setLayout(layout) {
  settings.layout = layout;
  applySettings();
}

// ---------------------------------------------------------------- console input

let histPos = history.length;
let histDraft = '';

function historyStep(dir) {
  const input = $('#input');
  if (histPos === history.length) histDraft = input.value;
  histPos = Math.max(0, Math.min(history.length, histPos + dir));
  input.value = histPos === history.length ? histDraft : history[histPos];
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---------------------------------------------------------------- misc UI

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// Fill the window; while the on-screen keyboard is up, shrink to the visible
// part so the REPL input stays above the keyboard.
function fitViewport() {
  const vv = window.visualViewport;
  const keyboard = vv && vv.height < window.innerHeight - 80;
  document.documentElement.classList.toggle('keyboard', !!keyboard);
  if (keyboard) document.documentElement.style.setProperty('--app-height', vv.height + 'px');
  if (window.scrollY) window.scrollTo(0, 0);
}

function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      console.error(e);
      toast('Something went wrong: ' + e.message);
    }
  };
}

function init() {
  editor = createEditor($('#editor'), {
    doc: files[current],
    onChange: scheduleSave,
    onRun: guard(() => loadFile(current)),
    onSave: guard(() => { saveFiles(); toast('Saved'); }),
  });
  $('#file-name').textContent = current;
  $('#save-state').textContent = 'Saved';
  $('#version').textContent = `Version ${APP_VERSION} · Haskell by MicroHs`;
  applySettings();

  $('#load-btn').addEventListener('click', guard(() => loadFile(current)));
  $('#stop-btn').addEventListener('click', guard(() => { write('^C\n', 'sys'); repl.interrupt(); }));
  $('#restart-btn').addEventListener('click', guard(() => {
    repl.restart('Restarting the interpreter…' + (loaded ? ` ${loaded} will be loaded again.` : ''));
  }));
  $('#font-up').addEventListener('click', () => setFont(2));
  $('#font-down').addEventListener('click', () => setFont(-2));
  $('#theme-btn').addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applySettings();
  });
  for (const b of document.querySelectorAll('.segmented button')) {
    b.addEventListener('click', () => setLayout(b.dataset.layout));
  }
  $('#clear-btn').addEventListener('click', clearOutput);
  $('#files-btn').addEventListener('click', openSheet);
  $('#file-name').addEventListener('click', guard(() => renameFile(current)));
  $('#files-sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.hasAttribute('data-close')) closeSheet();
  });
  $('#new-file').addEventListener('click', guard(newFile));
  $('#import-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', guard(async (e) => {
    await importFiles(e.target.files);
    e.target.value = '';
  }));
  $('#export-file').addEventListener('click', guard(exportFile));
  $('#share-btn').addEventListener('click', guard(shareFile));
  $('#copy-link').addEventListener('click', guard(copyLink));
  $('#send-link').addEventListener('click', guard(sendLink));
  $('#share-sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.hasAttribute('data-close')) $('#share-sheet').hidden = true;
  });
  window.addEventListener('hashchange', guard(receiveShared));

  const input = $('#input');
  $('#input-row').addEventListener('submit', guard((e) => {
    e.preventDefault();
    const v = input.value;
    if (runLine(v) !== false) input.value = '';
  }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); historyStep(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); historyStep(1); }
    else if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); write('^C\n', 'sys'); repl.interrupt(); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clearOutput(); }
  });
  outEl.addEventListener('click', (e) => {
    // Tapping the transcript focuses the input, unless text is being selected.
    if (!window.getSelection().toString() && !e.target.classList.contains('loc')) input.focus({ preventScroll: true });
  });

  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setFont(2); }
    else if (e.key === '-') { e.preventDefault(); setFont(-2); }
    else if (e.key === 'k' && e.metaKey) { e.preventDefault(); clearOutput(); }
    else if (e.key === 'Enter') { e.preventDefault(); guard(() => loadFile(current))(); }
    else if (e.key === '.' && e.metaKey) { e.preventDefault(); repl.interrupt(); }
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);
  fitViewport();

  const flush = () => { if (dirty) saveFiles(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  window.addEventListener('error', (e) => { console.error(e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });

  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  window.__repl = repl;   // for tests and debugging
  window.__editor = editor;
  write('Haskell REPL (MicroHs). Type an expression below, or tap Load to load the file in the editor.\n', 'sys');
  repl.start();
  guard(receiveShared)();
}

init();
