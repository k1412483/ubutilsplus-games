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
