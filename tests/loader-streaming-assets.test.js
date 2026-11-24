'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual loader without starting its browser initialization.
const loader = fs.readFileSync(path.join(__dirname, '..', 'loader.html'), 'utf8');
const script = loader.match(/<script>\s*([\s\S]*?)\s*<\/script>/i)[1];
assert.ok(script.includes('  initializeLoader();'));
const context = {
  Blob, TextEncoder, URL, URLSearchParams,
  window: { location: { search: '' }, addEventListener() {} },
  document: { getElementById() { return {}; } }
};
vm.runInNewContext(script.replace('  initializeLoader();', '  globalThis.prepareLargeGameBlob = prepareLargeGameBlob;'), context);

const repoBase = 'https://raw.githubusercontent.com/k1412483/ubutilsplus-games/refs/heads/main/';
// Larger than the tail scan, to exercise the same Blob-slicing path as the games.
const fixture = tail => new Blob(['<!doctype html><html><head></head><body><!--', 'x'.repeat(140 * 1024), '-->', tail, '</body></html>'], { type: 'text/html' });

async function prepare(tail, gamePath, id) {
  return (await context.prepareLargeGameBlob(fixture(tail), repoBase, id, { path: gamePath })).text();
}

test('Get Yoked relative StreamingAssets config becomes a safe absolute URL', async () => {
  const html = await prepare(`<script src="https://static.cloudflareinsights.com/beacon.min.js"></script><script>const config={streamingAssetsUrl: 'StreamingAssets'};</script>`, 'Get-Yoked.html', '13');
  assert.ok(html.includes(`<base href="${repoBase}">`));
  assert.ok(!html.includes('cloudflareinsights'));
  const match = html.match(/streamingAssetsUrl:\s*("[^"]+")/);
  assert.ok(match);
  const absolute = JSON.parse(match[1]);
  assert.equal(absolute, `${repoBase}StreamingAssets/`);
  assert.equal(new URL(absolute, 'blob:null/test').href, absolute);
});

test('absolute values stay unchanged and relative values are safely escaped', async () => {
  const source = `<script>const a={streamingAssetsUrl: 'https://example.com/assets'}; const b={streamingAssetsUrl:"assets/\\x3c\\\""}; const c={'streamingAssetsUrl':'./assets?version=1#part'};</script>`;
  const html = await prepare(source, 'Get-Yoked.html', '13');
  assert.ok(html.includes("streamingAssetsUrl: 'https://example.com/assets'"));
  const literal = html.match(/streamingAssetsUrl:("[^"\\]*(?:\\.[^"\\]*)*")/)[1];
  const absolute = JSON.parse(literal);
  assert.equal(absolute, `${repoBase}assets/%3C%22/`);
  assert.equal(new URL(absolute, 'blob:null/test').href, absolute);
  assert.ok(html.includes(`'streamingAssetsUrl':"${repoBase}assets/?version=1#part"`));
});

test('Super Mario Construct retains its virtual base and uses it for relative assets', async () => {
  const html = await prepare(`<script>const config={streamingAssetsUrl: 'StreamingAssets'};</script>`, 'Super-Mario-Construct.html', '15');
  assert.ok(html.includes('<base href="file:///__pm_smc__/">'));
  assert.ok(html.includes('streamingAssetsUrl: "file:///__pm_smc__/StreamingAssets/"'));
  assert.ok(html.includes('function SMCWorker(url, options)'));
});

test('the checked-in Get Yoked export is normalized without decoding its body', async () => {
  const source = new Blob([fs.readFileSync(path.join(__dirname, '..', 'Get-Yoked.html'))]);
  const prepared = await context.prepareLargeGameBlob(source, repoBase, '13', { path: 'Get-Yoked.html' });
  const tail = await prepared.slice(-128 * 1024).text();
  assert.ok(tail.includes(`streamingAssetsUrl:"${repoBase}StreamingAssets/"`));
  assert.ok(tail.includes('</html>'));
});

test('Get Yoked guards the real embedded FMOD worklet capability checks', async () => {
  const zlib = require('node:zlib');
  const sourceBytes = fs.readFileSync(path.join(__dirname, '..', 'Get-Yoked.html'));
  const payloadStart = sourceBytes.indexOf('>', sourceBytes.indexOf('<script id="payload"')) + 1;
  const payloadEnd = sourceBytes.indexOf('</script>', payloadStart);
  const zip = Buffer.from(sourceBytes.subarray(payloadStart, payloadEnd).toString(), 'base64');
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  let entry = zip.readUInt32LE(eocd + 16);
  let framework;
  while (zip.readUInt32LE(entry) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(entry + 28);
    const extraLength = zip.readUInt16LE(entry + 30);
    const commentLength = zip.readUInt16LE(entry + 32);
    const name = zip.toString('utf8', entry + 46, entry + 46 + nameLength);
    if (name === 'Build/Web.framework.js') {
      const local = zip.readUInt32LE(entry + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(start, start + zip.readUInt32LE(entry + 20));
      framework = zip.readUInt16LE(entry + 10) === 8 ? zlib.inflateRawSync(compressed) : compressed;
      break;
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  assert.ok(framework, 'embedded Unity framework exists');
  const original = framework.toString('utf8');
  assert.ok(original.includes('if(contextForCheck.audioWorklet.addModule)'));
  assert.ok(original.includes('if(!Module.mContext.audioWorklet.addModule)'));

  const prepared = await context.prepareLargeGameBlob(new Blob([sourceBytes]), repoBase, '13', { path: 'Get-Yoked.html' });
  const tail = await prepared.slice(-128 * 1024).text();
  const setup = tail.match(/const frameworkText=[\s\S]*?const frameworkBlob=new Blob\(\[frameworkText\],\{type:'text\/javascript;charset=utf-8'\}\);/);
  assert.ok(setup, 'framework guard is inserted before the Unity framework Blob');
  const sandbox = { files: { 'Build/Web.framework.js': framework }, Blob, TextDecoder };
  vm.runInNewContext(`${setup[0]}\nglobalThis.result = frameworkBlob;`, sandbox);
  const patched = await sandbox.result.text();
  assert.ok(patched.includes('if(contextForCheck.audioWorklet&&contextForCheck.audioWorklet.addModule)'));
  assert.ok(patched.includes('if(!Module.mContext.audioWorklet||!Module.mContext.audioWorklet.addModule)'));

  const check = patched.match(/7284991:(\(\)=>\{.*?\})\};function ExitStatus/)[1];
  let closed = 0;
  function runCheck(worklet) {
    const AudioContext = function() { this.audioWorklet = worklet; this.close = () => { closed++; }; };
    return vm.runInNewContext(`(${check})()`, { window: { AudioContext }, self: { AudioWorkletNode: function() {} } });
  }
  assert.equal(runCheck(undefined), 0);
  assert.equal(runCheck({ addModule() {} }), 1);
  assert.equal(closed, 2);
  const init = patched.match(/7276433:(\$0=>\{.*?\}),7276867:/)[1];
  const runInit = worklet => vm.runInNewContext(`(${init})(1)`, {
    self: { AudioWorkletNode: function() {} },
    Module: { mContext: { audioWorklet: worklet, sampleRate: 44100 }, cwrap() {} }
  });
  assert.equal(runInit(undefined), -2);
  assert.equal(runInit({ addModule() {} }), 44100);
});
