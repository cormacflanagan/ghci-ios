// Share links: a file travels inside the URL fragment (never sent to a server),
// compressed when the browser supports it, and is shown as a QR code.
// Bundled by scripts/build-editor.mjs into web/vendor/share.js.
import qrcode from 'qrcode-generator';

// Largest URL a version 40 QR code holds with low error correction (bytes).
export const QR_MAX = 2953;

function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// The fragment for a file: "#f=<name>&z=<deflated text>" or "&t=<plain text>".
export async function makeFragment(name, text) {
  const bytes = new TextEncoder().encode(text);
  let data;
  if (canCompress) {
    try {
      data = 'z=' + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')));
    } catch (e) {
      data = null;
    }
  }
  if (!data) data = 't=' + toBase64Url(bytes);
  return '#f=' + encodeURIComponent(name) + '&' + data;
}

// Returns {name, text} for a share fragment, null if there is none, and
// throws if the fragment is damaged.
export async function readFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const name = params.get('f');
  if (!name) return null;
  let bytes;
  if (params.has('z')) {
    if (!canCompress) throw new Error('This browser is too old to open compressed share links.');
    bytes = await pipe(fromBase64Url(params.get('z')), new DecompressionStream('deflate-raw'));
  } else if (params.has('t')) {
    bytes = fromBase64Url(params.get('t'));
  } else {
    throw new Error('The share link is incomplete.');
  }
  return { name, text: new TextDecoder().decode(bytes) };
}

// An SVG QR code for `text`, or null if it is too long for a QR code.
export function qrSvg(text) {
  if (new TextEncoder().encode(text).length > QR_MAX) return null;
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 4;   // quiet zone
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
    }
  }
  const size = n + 2 * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
