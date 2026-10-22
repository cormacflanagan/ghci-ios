// End-to-end test in Chromium with an iPad-sized touch viewport.
//   node tests/e2e.mjs            (CHROMIUM=/path/to/chrome to pick a browser)
import { chromium, devices } from 'playwright';
import { serve } from '../scripts/serve.mjs';
import fs from 'node:fs';

const PORT = 8130;
const server = await serve(PORT);
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); if (process.env.DEBUG) console.log('PAGEERROR', e.stack); });
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (globalThis.nextPrompt ?? '') : undefined));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

const output = () => page.$eval('#output', (el) => el.innerText);
const status = () => page.$eval('#status', (el) => el.textContent);

async function waitReady(ms = 60000) {
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready', null, { timeout: ms });
}

async function run(line, ms = 30000) {
  const before = (await output()).length;
  await page.fill('#input', line);
  await page.press('#input', 'Enter');
  await page.waitForTimeout(50);
  await waitReady(ms);
  await page.waitForTimeout(100);
  return (await output()).slice(before);
}

async function setEditor(text) {
  await page.evaluate((t) => {
    const view = window.__editor.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
  }, text);
}

try {
  await page.goto(`http://localhost:${PORT}/`);
  await waitReady();
  check('starts and becomes ready', true);

  let o = await run('2 + 3 * 4');
  check('evaluates an expression', o.includes('14'), o);

  o = await run(':t map');
  check(':t works', o.includes('(a -> b) -> [a] -> [b]'), o);

  // Load the sample file.
  o = await run(':load Intro');
  check(':load sample', /Ok, Intro loaded/.test(o), o);
  o = await run('quicksort [3,1,4,1,5,9,2,6]');
  check('uses loaded definitions', o.includes('[1,1,2,3,4,5,6,9]'), o);

  // Edit and reload with the Load button.
  await setEditor('double :: Int -> Int\ndouble x = x + x + 1\n');
  await page.click('#load-btn');
  await page.waitForTimeout(100);
  await waitReady();
  o = await run('double 10');
  check('Load button picks up edits (headerless file)', o.includes('21'), o);

  // A type error is reported at the right line of a headerless file and links to it.
  await setEditor('x :: Int\nx = 1\n\ny :: Int\ny = "no"\n');
  await page.click('#load-btn');
  await page.waitForTimeout(100);
  await waitReady();
  o = await output();
  check('error location is shifted back to the file\'s own lines', /Intro\.hs:5:\d+/.test(o), o.slice(-400));
  check('failed load is reported', o.includes('Failed to load Intro.hs'), o.slice(-200));
  const loc = await page.$('#output .loc');
  check('error line is clickable', !!loc);
  if (loc) {
    await loc.click();
    const line = await page.evaluate(() => {
      const v = window.__editor.view;
      return v.state.doc.lineAt(v.state.selection.main.head).number;
    });
    check('clicking the error moves the cursor to it', line === 5, String(line));
  }

  // Runaway evaluation: Stop interrupts it.
  await setEditor('module Intro where\n\nloop :: Int -> Int\nloop n = loop (n + 1)\n');
  await page.click('#load-btn');
  await page.waitForTimeout(100);
  await waitReady();
  await page.fill('#input', 'loop 0');
  await page.press('#input', 'Enter');
  await page.waitForTimeout(1500);
  check('shows Running while busy', (await status()) === 'Running…');
  await page.click('#stop-btn');
  await waitReady(15000);
  await page.waitForFunction(() => /user interrupt|restarted/.test(document.querySelector('#output').innerText), null, { timeout: 5000 }).catch(() => {});
  o = await output();
  check('Stop interrupts a loop', /user interrupt|restarted/.test(o), o.slice(-200));
  o = await run('1 + 1');
  check('REPL usable after Stop', o.includes('2'), o);

  // Deep recursion is an exception, not a crash.
  o = await run('foldr (+) 0 [1..1000000]', 60000);
  check('deep recursion gives stack overflow exception', /stack overflow|restarting/i.test(o), o);
  o = await run('3 + 3');
  check('REPL usable after stack overflow', o.includes('6'), o);

  // Runaway memory: Stop recovers (by restarting if needed).
  await run('let xs = [1..] :: [Integer]');
  await page.fill('#input', 'length xs');
  await page.press('#input', 'Enter');
  await page.waitForTimeout(3000);
  await page.click('#stop-btn');
  await waitReady(60000);
  o = await run('4 + 4');
  check('REPL usable after memory hog', o.includes('8'), o);

  // A program that reads stdin.
  await setEditor('module Intro where\n\ngreet :: IO ()\ngreet = do\n  putStrLn "Name?"\n  n <- getLine\n  putStrLn ("Hello, " ++ n ++ "!")\n');
  await page.click('#load-btn');
  await page.waitForTimeout(100);
  await waitReady();
  await page.fill('#input', 'greet');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#output').innerText.includes('Name?'), null, { timeout: 30000 });
  await page.fill('#input', 'Ada');
  await page.press('#input', 'Enter');
  await waitReady();
  o = await output();
  check('stdin works for getLine', o.includes('Hello, Ada!'), o.slice(-200));

  // Smart punctuation from the iPad keyboard is undone.
  o = await run('length “hello”');
  check('smart quotes are fixed in the REPL', /\b5\b/.test(o), o);

  // Multiple modules.
  globalThis.nextPrompt = 'Helpers';
  await page.click('#files-btn');
  await page.click('#new-file');
  await setEditor('module Helpers where\n\ntriple :: Int -> Int\ntriple = (* 3)\n');
  await page.waitForTimeout(600);
  check('new file is current', (await page.textContent('#file-name')) === 'Helpers.hs');
  await page.click('#files-btn');
  await page.click('#file-list li:has-text("Intro.hs") .open');
  await setEditor('module Intro where\n\nimport Helpers\n\nnine :: Int\nnine = triple 3\n');
  await page.click('#load-btn');
  await page.waitForTimeout(100);
  await waitReady();
  o = await run('nine');
  check('a file can import another file', o.includes('9'), o);

  // Restart keeps the loaded file.
  await page.click('#restart-btn');
  await page.waitForTimeout(200);
  await waitReady(60000);
  await page.waitForTimeout(500);
  await waitReady(60000);
  o = await run('nine');
  check('Restart reloads the loaded file', o.includes('9'), o);

  // The runtime dying (as on a native stack overflow) is recovered from.
  const depthBefore = await page.evaluate(() => window.__repl.depth);
  await page.evaluate(() => window.__repl.crash('RangeError: Maximum call stack size exceeded'));
  await page.waitForTimeout(200);
  await waitReady(60000);
  await page.waitForTimeout(500);
  await waitReady(60000);
  o = await run('nine');
  check('recovers from a runtime crash and reloads', o.includes('9'), o);
  const depthAfter = await page.evaluate(() => window.__repl.depth);
  check('a native stack overflow lowers the depth limit', depthAfter < depthBefore, depthBefore + ' -> ' + depthAfter);

  // Files persist across reloads.
  await page.waitForTimeout(600);
  await page.reload();
  await waitReady();
  const names = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ghci.files'))));
  check('files persist', names.includes('Helpers.hs') && names.includes('Intro.hs'), names.join(','));
  check('current file persists', (await page.textContent('#file-name')) === 'Intro.hs');

  // Import from device.
  fs.writeFileSync('/tmp/lab 3.hs', 'module Lab3 where\nanswer = 42\n');
  await page.setInputFiles('#file-input', '/tmp/lab 3.hs');
  await page.waitForTimeout(300);
  check('import renames to a valid module file', (await page.textContent('#file-name')) === 'Lab3.hs');

  // Font size and theme.
  const fs1 = await page.$eval('#output', (el) => getComputedStyle(el).fontSize);
  await page.click('#font-up');
  const fs2 = await page.$eval('#output', (el) => getComputedStyle(el).fontSize);
  check('font size increases', parseFloat(fs2) > parseFloat(fs1), fs1 + ' -> ' + fs2);

  // Ink: Pencil and mouse draw over the panes without clicking through.
  const inkPixels = () => page.evaluate(() => {
    const c = document.querySelector('#ink');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  });
  const penStroke = (x0, y0, x1, y1) => page.evaluate(([x0, y0, x1, y1]) => {
    const target = document.elementFromPoint(x0, y0);
    const ev = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'pen',
      clientX: x, clientY: y, pressure: 0.6, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    });
    target.dispatchEvent(ev('pointerdown', x0, y0));
    for (let i = 1; i <= 10; i++) target.dispatchEvent(ev('pointermove', x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10));
    target.dispatchEvent(ev('pointerup', x1, y1));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x1, clientY: y1 }));
  }, [x0, y0, x1, y1]);
  await page.click('#ink-btn');
  check('ink palette appears', await page.isVisible('#ink-bar'));
  const docBefore = await page.evaluate(() => window.__editor.getText());
  const ed = await page.$eval('#editor', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await penStroke(ed.x + 100, ed.y + 100, ed.x + 300, ed.y + 160);
  await page.waitForTimeout(100);
  check('pencil draws', (await inkPixels()) > 100);
  check('pencil stroke does not edit the code', (await page.evaluate(() => window.__editor.getText())) === docBefore);
  await page.mouse.move(ed.x + 100, ed.y + 300);
  await page.mouse.down();
  await page.mouse.move(ed.x + 250, ed.y + 350, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  check('mouse draws in ink mode', (await page.evaluate(() => window.__ink.strokeCount())) === 2);
  await page.click('#ink-bar [data-tool="erase"]');
  await penStroke(ed.x + 150, ed.y + 300, ed.x + 250, ed.y + 360);
  await page.waitForTimeout(100);
  check('eraser removes a stroke', (await page.evaluate(() => window.__ink.strokeCount())) === 1);
  await page.click('#ink-bar [data-action="clear"]');
  await page.waitForTimeout(100);
  check('clear removes all ink', (await inkPixels()) === 0);
  await page.click('#ink-bar [data-color="#1e6fd9"]');
  await page.click('#ink-bar [data-action="fade"]');
  await penStroke(ed.x + 100, ed.y + 100, ed.x + 300, ed.y + 160);
  await page.waitForTimeout(200);
  const shown = await inkPixels();
  await page.waitForTimeout(3600);
  check('fading ink disappears', shown > 100 && (await inkPixels()) === 0, `${shown}`);
  await page.click('#ink-bar [data-action="fade"]');
  await page.click('#ink-btn');
  check('ink off hides the palette', !(await page.isVisible('#ink-bar')));
  o = await run('1 + 2');
  check('REPL still works after drawing', o.includes('3'), o);

  // Share: the QR code appears, and the link opens the file elsewhere.
  await page.click('#files-btn');
  await page.click('#file-list li:has-text("Helpers.hs") .open');
  await page.click('#share-btn');
  await page.waitForSelector('#qr svg');
  check('share shows a QR code', true);
  await page.screenshot({ path: (process.env.SHOT || '/tmp/ghci-ipad.png').replace('.png', '-share.png') });
  const link = await page.evaluate(async () => {
    const { makeFragment } = await import('./vendor/share.js');
    return location.origin + location.pathname + await makeFragment('Helpers.hs', 'module Helpers where\n\ntriple :: Int -> Int\ntriple = (* 3)\n');
  });
  await page.click('#share-sheet [data-close]');
  const student = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  await student.goto(link);
  student.on('console', (m) => process.env.DEBUG && console.log('student:', m.text()));
  globalThis.student = student;
  await student.waitForFunction(() => document.querySelector('#output').innerText.includes('Ok, Helpers loaded'), null, { timeout: 90000 });
  check('share link opens and loads the file', (await student.textContent('#file-name')) === 'Helpers.hs');
  check('share link is removed from the address bar', !(await student.evaluate(() => location.hash)));
  await student.fill('#input', 'triple 5');
  await student.press('#input', 'Enter');
  await student.waitForFunction(() => /\n15\n?/.test(document.querySelector('#output').innerText), null, { timeout: 30000 });
  check('shared definitions run', true);

  await page.screenshot({ path: process.env.SHOT || '/tmp/ghci-ipad.png' });
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
} catch (e) {
  failures++;
  console.log('FAIL exception', e.message);
  console.log((await output().catch(() => '')).slice(-1500));
  if (globalThis.student) console.log('STUDENT:', await globalThis.student.evaluate(() => document.querySelector('#file-name').textContent + ' | ' + document.querySelector('#status').textContent + ' | ' + document.querySelector('#output').innerText + ' | ' + location.href).catch((e) => e.message));
  await page.screenshot({ path: '/tmp/ghci-fail.png' }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
