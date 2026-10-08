const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/../src/index.js', 'utf8').replace('export default {', 'const worker = {');
function setup(fetch, time = '2026-10-08T14:00:00Z', timers = {}) {
  const context = vm.createContext({
    fetch, AbortController, URL, Intl, JSON, Set, Map, TextEncoder,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [time])); } },
    console: { log() {}, error() {} }, setTimeout, clearTimeout, ...timers,
  });
  vm.runInContext(source, context);
  return context;
}
const heartbeat = 'https://example.test/heartbeat/test-token';
const env = { BETTERSTACK_HEARTBEAT_URL: heartbeat, FIXR_STATE: { get: async () => ({seen_event_urls: []}) } };
test('normal scheduled run sends one success heartbeat after checking FIXR', async () => {
  const urls = [];
  const c = setup(async url => { urls.push(url); return new Response('<html></html>'); });
  await c.runScheduledCheck(env);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], heartbeat);
});
test('transient heartbeat failure retries success URL without reporting FIXR failure', async () => {
  const urls = [];
  const c = setup(async url => { urls.push(url); return new Response('', {status: urls.length === 2 ? 503 : 200}); });
  await c.runScheduledCheck(env);
  assert.deepEqual(urls.slice(1), [heartbeat, heartbeat]);
});
test('FIXR error sends failure heartbeat', async () => {
  const urls = [];
  const c = setup(async url => { urls.push(url); return new Response('', {status: urls.length === 1 ? 503 : 200}); });
  await c.runScheduledCheck(env);
  assert.equal(urls[1], heartbeat + '/fail');
});
test('outside monitoring hours skips FIXR and still sends heartbeat', async () => {
  const urls = [];
  const c = setup(async url => { urls.push(url); return new Response(''); }, '2026-10-08T02:00:00Z');
  await c.runScheduledCheck(env);
  assert.deepEqual(urls, [heartbeat]);
});
test('persistent heartbeat failure rejects scheduled task after three attempts', async () => {
  const urls = [];
  const c = setup(async url => { urls.push(url); return new Response('', {status: 503}); }, '2026-10-08T02:00:00Z');
  await assert.rejects(c.runScheduledCheck(env), /after 3 attempts/);
  assert.deepEqual(urls, [heartbeat, heartbeat, heartbeat]);
});
test('missing heartbeat secret rejects task', async () => {
  const c = setup(async () => { throw new Error('unexpected fetch'); }, '2026-10-08T02:00:00Z');
  await assert.rejects(c.runScheduledCheck({}), /secret is missing/);
});
test('timeout aborts stalled response body and clears timer', async () => {
  let abort, cleared = false;
  const c = setup(async (url, options) => ({
    ok: true, status: 200,
    text: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      queueMicrotask(abort);
    }),
  }), undefined, {setTimeout: callback => { abort = callback; return 1; }, clearTimeout: () => { cleared = true; }});
  await assert.rejects(c.fetchWithTimeout('https://example.test'), /aborted/);
  assert.equal(cleared, true);
});
