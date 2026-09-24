// ONE CACHE FOR ONE FETCH (#218).
//
// src/ui/packSource.js has always cached the manifest PROMISE, so five lobby
// tiles asking at once cost one request. What it could not do was answer a
// caller that has no await to give it — and a repaint is exactly that caller.
// So src/ui/party.js kept two Maps of its own, `packNames` and `packTeams`,
// filled from the same fetch, written in three places, using `null` as an
// in-flight sentinel, and remembering a failed fetch as the answer for the
// life of the page.
//
// `knownManifest` and `askedForManifest` are the synchronous half of the one
// cache, and this file is what stops them drifting back apart: the settled
// value is the fetched one, "asked" covers in-flight as well as held, and a
// failure is remembered by neither — which is the retry the PWA case needs and
// the one thing party.js's copy got wrong.

import { test } from 'node:test';
import assert from 'node:assert';

/**
 * A FRESH MODULE PER TEST, because the cache is module state and a test that
 * inherited the previous one's would pass on somebody else's fetch. The query
 * string is the only way to ask Node's loader for a second instance.
 */
let instance = 0;
async function freshPackSource(responder) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return responder(url, calls.length);
  };
  const mod = await import(`../src/ui/packSource.js?probe=${instance++}`);
  return { mod, calls, restore: () => { globalThis.fetch = previous; } };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('a manifest is fetched once and readable synchronously afterwards', async () => {
  const manifest = { id: 'crazy-eights', name: 'Crazy Eights', players: { teams: 2 } };
  const { mod, calls, restore } = await freshPackSource(() => okJson(manifest));
  try {
    assert.equal(mod.knownManifest('crazy-eights'), null, 'nothing is known before anything is asked');
    assert.equal(mod.askedForManifest('crazy-eights'), false);

    const first = mod.fetchPackManifest('crazy-eights');
    // IN FLIGHT COUNTS AS ASKED. This is what makes "never ask twice" a
    // property of the cache rather than a sentinel the caller has to write.
    assert.equal(mod.askedForManifest('crazy-eights'), true);
    assert.equal(mod.knownManifest('crazy-eights'), null, 'a pending fetch is not an answer');

    assert.strictEqual(mod.fetchPackManifest('crazy-eights'), first, 'the same promise, not a second request');
    await first;

    assert.deepEqual(mod.knownManifest('crazy-eights'), manifest);
    assert.equal(mod.knownManifest('crazy-eights').players.teams, 2,
      'the teams come off the same read as the name — one fetch, both facts');
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('a failed manifest fetch is remembered by neither half of the cache', async () => {
  // OFFLINE-THEN-ONLINE IS THE ORDINARY CASE FOR A PWA. party.js's own Map
  // wrote the pack's id in as its name on failure and never asked again, so a
  // tile that missed one fetch showed `crazy-eights` until the tab was closed.
  const { mod, calls, restore } = await freshPackSource((url, n) => (n === 1
    ? { ok: false, status: 503, json: async () => ({}) }
    : okJson({ id: 'hearts', name: 'Hearts' })));
  try {
    await assert.rejects(mod.fetchPackManifest('hearts'));
    assert.equal(mod.knownManifest('hearts'), null, 'a failure is not an answer');
    assert.equal(mod.askedForManifest('hearts'), false, 'and it does not block the retry');

    await mod.fetchPackManifest('hearts');
    assert.equal(mod.knownManifest('hearts').name, 'Hearts');
    assert.equal(calls.length, 2);
  } finally { restore(); }
});

test('a pack id that is not one is refused before it reaches a fetch path', async () => {
  const { mod, calls, restore } = await freshPackSource(() => okJson({}));
  try {
    assert.throws(() => mod.fetchPackManifest('../../etc/passwd'));
    assert.equal(calls.length, 0, 'a bad id built a URL anyway');
    assert.equal(mod.knownManifest('../../etc/passwd'), null);
  } finally { restore(); }
});
