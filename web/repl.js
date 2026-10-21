// Drives the MicroHs REPL running in worker.js.
//
// The REPL is a line-based terminal program.  We send it whole lines, watch
// its output for the prompt to know when it is idle, and restart the worker
// if it dies or stops responding.  Nothing that happens inside the worker
// can take the page down with it.

const PROMPT = 'λ> ';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class Repl {
  // handlers: {
  //   output(text, kind)  kind: 'out' | 'cmd' | 'stdin' | 'sys' | 'ok' | 'err'
  //   state(s)            s: 'starting' | 'ready' | 'busy' | 'restarting' | 'failed'
  //   crashed(reason)     the runtime died (before it is restarted)
  //   started()           a fresh interpreter reached its first prompt
  // }
  constructor(handlers, { depth = 800 } = {}) {
    this.h = handlers;
    this.depth = depth;
    this.worker = null;
    this.generation = 0;
    this.files = new Map();       // path -> text currently in the worker's file system
    this.atPrompt = false;
    this.queue = [];              // commands waiting for the prompt
    this.current = null;          // command being run
    this.startFailures = 0;
  }

  start(reason) {
    this.stopWorker();
    const gen = ++this.generation;
    this.atPrompt = false;
    this.queue = [];
    this.current = null;
    this.held = '';
    this.swallow = '';
    this.decoder = new TextDecoder();
    this.files = new Map();
    this.setState(reason ? 'restarting' : 'starting');

    let w;
    try {
      w = new Worker('worker.js');
    } catch (e) {
      this.setState('failed');
      this.h.output('Could not start the Haskell interpreter: ' + e.message + '\n', 'err');
      return;
    }
    this.worker = w;
    w.onmessage = (ev) => { if (gen === this.generation) this.onMessage(ev.data); };
    w.onerror = (ev) => {
      if (gen !== this.generation) return;
      ev.preventDefault && ev.preventDefault();
      this.crash(ev.message || 'worker error');
    };

    // The first prompt (plus a warm-up evaluation, which takes a while the
    // first time) must arrive within this time, or we try again.
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      if (gen !== this.generation || this.started) return;
      this.crash('the interpreter did not start in time');
    }, 60000);
    this.started = false;

    // Hidden warm-up so the first real expression is fast.
    this.enqueue({ line: '()', silent: true, onDone: () => this.onStarted(gen) });
  }

  onStarted(gen) {
    if (gen !== this.generation) return;
    this.started = true;
    this.startFailures = 0;
    clearTimeout(this.startTimer);
    this.h.started && this.h.started();
  }

  stopWorker() {
    clearTimeout(this.stopTimer);
    clearTimeout(this.startTimer);
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) { /* ignore */ }
      this.worker = null;
    }
  }

  restart(message) {
    if (message) this.h.output(message + '\n', 'sys');
    this.start(true);
  }

  crash(reason) {
    this.stopWorker();
    this.h.crashed && this.h.crashed(String(reason));
    this.startFailures++;
    if (this.startFailures > 3) {
      this.setState('failed');
      this.h.output('The interpreter keeps failing to start. Close and reopen the app.\n', 'err');
      return;
    }
    this.start(true);
  }

  setState(s) {
    this.state = s;
    this.h.state(s);
  }

  post(msg) {
    try { this.worker && this.worker.postMessage(msg); } catch (e) { /* ignore */ }
  }

  // Make the worker's copy of a file match `text`.
  writeFile(path, text) {
    if (this.files.get(path) === text) return;
    this.files.set(path, text);
    this.post({ type: 'write', path, text });
  }

  removeFile(path) {
    if (!this.files.has(path)) return;
    this.files.delete(path);
    this.post({ type: 'remove', path });
  }

  setDepth(n) {
    this.depth = n;
    this.post({ type: 'depth', n });
  }

  // Queue a REPL command.  Options:
  //   silent   hide its echo and all its output
  //   echo     show "λ> line" in the transcript (default true unless silent)
  //   filter   function(line) -> false to hide an output line
  //   onDone   called with all output text once the prompt comes back
  enqueue(cmd) {
    this.queue.push(cmd);
    this.pump();
  }

  get busy() {
    return !this.atPrompt || this.current !== null || this.queue.length > 0;
  }

  pump() {
    if (!this.atPrompt || this.current || this.queue.length === 0) return;
    const cmd = this.queue.shift();
    this.current = cmd;
    this.atPrompt = false;
    cmd.output = '';
    if (!cmd.silent && cmd.echo !== false) this.h.output(PROMPT + (cmd.display || cmd.line) + '\n', 'cmd');
    this.swallow = cmd.line + '\n';   // the REPL echoes what it reads
    if (this.started) this.setState('busy');
    this.post({ type: 'input', text: cmd.line.replace(/\t/g, '  ') + '\n' });
  }

  // A line typed while a program is running goes to its stdin.
  sendStdin(line) {
    this.h.output(line + '\n', 'stdin');
    this.post({ type: 'input', text: line + '\n' });
  }

  interrupt() {
    if (!this.worker || this.atPrompt) return;
    this.queue = [];
    this.post({ type: 'input', text: '\x03' });
    clearTimeout(this.stopTimer);
    const gen = this.generation;
    this.stopTimer = setTimeout(() => {
      if (gen === this.generation && !this.atPrompt) {
        this.restart('The expression did not stop, so the interpreter was restarted.');
      }
    }, 2500);
  }

  onMessage(m) {
    if (m.type === 'out') {
      this.onOutput(this.decoder.decode(m.bytes, { stream: true }));
    } else if (m.type === 'ready') {
      this.post({ type: 'depth', n: this.depth });
    } else if (m.type === 'abort') {
      this.crash(m.reason);
    } else if (m.type === 'log') {
      console.log('[mhs]', m.text);
    }
  }

  onOutput(chunk) {
    let text = this.held + chunk.replace(ANSI, '').replace(/\r/g, '').replace(/\x07/g, '');
    this.held = '';

    // Drop the REPL's echo of the line we sent.
    while (this.swallow && text) {
      if (text[0] === this.swallow[0]) {
        text = text.slice(1);
        this.swallow = this.swallow.slice(1);
      } else if (text[0] === '\x08') {
        text = text.slice(1);
      } else {
        this.swallow = '';
      }
    }
    // Backspaces only come from line editing; apply them.
    text = text.replace(/[^\n\x08]\x08/g, '').replace(/\x08/g, '');

    let prompt = false;
    if (text.endsWith(PROMPT)) {
      text = text.slice(0, -PROMPT.length);
      prompt = true;
    } else {
      // Keep back a possible start of the prompt until we see more.
      for (let k = PROMPT.length - 1; k > 0; k--) {
        if (text.endsWith(PROMPT.slice(0, k))) {
          this.held = text.slice(-k);
          text = text.slice(0, -k);
          break;
        }
      }
    }

    if (!this.started) {
      // The interpreter's banner; :quit is not available here anyway.
      text = text.replace(/^(Welcome to interactive|Integer implemented|Loading embedded package|Type ':quit').*\n/gm, '');
    }

    const cmd = this.current;
    if (text) {
      if (cmd) cmd.output += text;
      if (!(cmd && cmd.silent)) this.emitText(text, cmd);
    }
    if (prompt) this.onPrompt();
  }

  emitText(text, cmd) {
    if (!cmd || !cmd.filter) {
      this.h.output(text, 'out');
      return;
    }
    // Filter whole lines; keep a partial last line until it is complete.
    const all = (cmd.partial || '') + text;
    const parts = all.split('\n');
    cmd.partial = parts.pop();
    for (const l of parts) if (cmd.filter(l) !== false) this.h.output(l + '\n', 'out');
  }

  onPrompt() {
    clearTimeout(this.stopTimer);
    const cmd = this.current;
    if (cmd && cmd.partial && cmd.filter && cmd.filter(cmd.partial) !== false && !cmd.silent) {
      this.h.output(cmd.partial, 'out');
    }
    this.current = null;
    this.atPrompt = true;
    if (cmd && cmd.onDone) {
      try { cmd.onDone(cmd.output); } catch (e) { console.error(e); }
    }
    if (this.atPrompt && !this.current) {
      this.h.prompt && this.h.prompt();
      if (this.queue.length === 0 && this.started) this.setState('ready');
    }
    this.pump();
  }
}

// Checks, in a throwaway worker with a small heap, whether evaluation nested
// `depth` levels deep fits in this browser's stack.  Resolves true/false.
export function probeDepth(depth, timeout = 30000) {
  return new Promise((resolve) => {
    let w;
    let out = '';
    let step = 0;
    const done = (ok) => {
      clearTimeout(timer);
      try { w.terminate(); } catch (e) { /* ignore */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeout);
    const dec = new TextDecoder();
    const send = (text) => { out = ''; w.postMessage({ type: 'input', text }); };
    try {
      w = new Worker('worker.js?small');
    } catch (e) {
      done(false);
      return;
    }
    w.onerror = (e) => { e.preventDefault(); done(false); };
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'abort') return done(false);
      if (m.type === 'ready') w.postMessage({ type: 'depth', n: depth });
      if (m.type !== 'out') return;
      out += dec.decode(m.bytes, { stream: true });
      if (!out.endsWith(PROMPT)) return;
      step++;
      if (step === 1) send('let f n = 1 + f n\n');
      else if (step === 2) send('f 1\n');
      else done(/stack overflow/.test(out));
    };
  });
}
