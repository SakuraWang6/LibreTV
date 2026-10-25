'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { watchDomReady, failureDiagnostic } = require('./protocol.cjs');

function dom(t, scripts = []) {
  const previous = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  const state = { frames: [], videos: [], scripts: scripts.map((textContent) => ({ textContent })) };
  globalThis.document = { scripts: state.scripts, querySelectorAll: (selector) => selector === 'iframe' ? state.frames : state.videos };
  globalThis.location = { href: 'https://libvio.host/w/714890608-3-1.html', origin: 'https://libvio.host' };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  return state;
}
const node = (src) => ({ getAttribute: () => src });

test('unsupported player encrypt3 does not become ready before the iframe is inserted', (t) => {
  const state = dom(t, ['var player_aaaa={"encrypt":3,"url":"https://v.vimsec.app/2024/series/E01.mp4"}']);
  state.frames.push(node(''), node('about:blank'));
  assert.equal(watchDomReady(), false);
  state.frames.push(node('/vid/plyr/vr2.php?url=https://v.vimsec.app/2024/series/E01.mp4'));
  assert.equal(watchDomReady(), true);
});
test('only ordinary strict JSON direct media can skip the iframe wait', (t) => {
  const state = dom(t, ['var player_a={"url":"https://cdn.example.test/a.mp4","encrypt":0};']);
  assert.equal(watchDomReady(), true);
  state.scripts[0].textContent = 'var player_a={url:(window.sideEffect=true,"https://cdn.example.test/a.mp4")}';
  assert.equal(watchDomReady(), false);
  state.scripts[0].textContent = 'var player_a={"url":"https://parser.example.test/index.php?url=https://cdn.test/a.mp4"}';
  assert.equal(watchDomReady(), false);
});
test('ordinary encoded direct URLs work while netdisk shares are not readiness signals', (t) => {
  const value = encodeURIComponent('https://cdn.example.test/a.m3u8');
  const state = dom(t, [`var player_a=${JSON.stringify({ url: value, encrypt: 1 })}`]);
  assert.equal(watchDomReady(), true);
  state.scripts[0].textContent = `var player_a=${JSON.stringify({ url: Buffer.from(value).toString('base64'), encrypt: 2 })}`;
  assert.equal(watchDomReady(), true);
  state.scripts[0].textContent = 'var player_a={"url":"https://pan.quark.cn/s/a.mp4","encrypt":0}';
  assert.equal(watchDomReady(), false);
});
test('blank, foreign and script frames do not replace a real official player frame', (t) => {
  const state = dom(t);
  state.frames.push(node(''), node('about:blank'), node('javascript:alert(1)'), node('https://evil.test/vid/plyr/vr2.php'));
  assert.equal(watchDomReady(), false);
  state.videos.push(node('https://cdn.example.test/a.mp4'));
  assert.equal(watchDomReady(), true);
});
test('failure diagnostics expose only fixed error classification and official path', () => {
  const diagnostic = failureDiagnostic({ name: 'Error', message: 'page.goto: net::ERR_ABORTED secret=must-not-leak', stack: 'private profile', cookie: 'private' }, 'https://libvio.host/w/123-1-1.html?token=secret', 'navigate');
  assert.deepEqual(diagnostic, { phase: 'navigate', name: 'Error', code: 'ERR_ABORTED', url: 'https://libvio.host/w/123-1-1.html' });
  assert.equal(failureDiagnostic({ name: 'Error /private/path', message: 'secret' }, 'https://evil.test/x?password=x', 'private').name, 'Error');
  assert.equal(failureDiagnostic({}, 'https://evil.test/x?password=x', 'unknown').url, '');
});
