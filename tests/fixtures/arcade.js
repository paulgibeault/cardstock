// THE ARCADE SDK, AS MUCH OF IT AS A NODE TEST NEEDS, IN ONE PLACE.
//
// `globalThis.Arcade` was stood up by hand in six test files: four Map-backed
// `state` stubs pasted verbatim (tableSightings.test.js said so in a comment),
// two `stats` stubs that disagreed about what `getOrInit` means, and two
// `session` timer stubs of different shapes. A stub that disagrees with the SDK
// is a test that passes against a platform nobody ships.
//
// THE SEMANTICS ARE THE REAL SDK'S, not a convenient reading of them
// (paulgibeault.github.io/arcade-sdk.js: `state.getOrInit` at :1781, `stats.getOrInit`
// at :2772, `deepMerge` at :526). Both getOrInits: store the defaults when the key
// is missing, and when a value IS stored deep-merge the defaults UNDER it, so a
// field added to the defaults since the last save arrives with its default rather
// than as undefined. `stats.test.js` had the other reading — stored value wins
// whole, defaults ignored — which is the one that hides exactly that bug.
//
// Stood up here rather than as a seam in src/: the production modules stay free
// of a test hook, which was the original reason each file did this for itself.

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The SDK's merge: `override` wins, key by key, all the way down. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, ov] of Object.entries(override)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const bv = base[k];
    out[k] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : ov;
  }
  return out;
}

/**
 * Install `globalThis.Arcade` with the surfaces asked for, and hand back the
 * Maps and the timer list behind them so a test can seed, clear and inspect.
 *
 * @param opts.state    the synchronous key/value store (`src/arcade/storage.js`)
 * @param opts.stats    the per-category counters
 * @param opts.session  the frame-aware timer (`Arcade.session.setTimeout`)
 * @returns `{ store, stats, timers, arcade }` — `timers` is a live array of
 *          `{ fn, ms, cancelled, cancel() }`, newest last, and `timers.length = 0`
 *          is how a test resets between cases.
 */
export function installArcade({ state = false, stats = false, session = false } = {}) {
  const store = new Map();
  const statsStore = new Map();
  const timers = [];
  const arcade = {};

  if (state) {
    arcade.state = {
      get: (k) => store.get(k),
      // Cloned on the way in: the SDK persists JSON, so a caller that mutates
      // the object it saved must not be changing what is stored.
      set: (k, v) => { store.set(k, structuredClone(v)); return true; },
      remove: (k) => store.delete(k),
      getOrInit: (k, d) => {
        if (!store.has(k)) { store.set(k, structuredClone(d)); return structuredClone(d); }
        const current = store.get(k);
        if (!isPlainObject(d) || !isPlainObject(current)) return current;
        // The real one writes the merge back, so a later plain `get` sees the
        // same shape getOrInit just returned.
        const merged = deepMerge(d, current);
        store.set(k, merged);
        return merged;
      },
    };
  }

  if (stats) {
    arcade.stats = {
      get: (c) => statsStore.get(c),
      getOrInit: (c, d) => {
        if (!statsStore.has(c)) { statsStore.set(c, structuredClone(d)); return d; }
        const current = statsStore.get(c);
        if (!isPlainObject(d) || !isPlainObject(current)) return current;
        // Unlike state's, the SDK's stats.getOrInit does NOT persist the merge.
        return deepMerge(d, current);
      },
      // `|| {}` because the SDK hands the updater `{}` for a category that has
      // never been written, never undefined.
      update: (c, fn) => { statsStore.set(c, structuredClone(fn(statsStore.get(c) || {}))); },
    };
  }

  if (session) {
    arcade.session = {
      setTimeout(fn, ms) {
        const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; } };
        timers.push(t);
        return t;
      },
    };
  }

  globalThis.Arcade = arcade;
  return { store, stats: statsStore, timers, arcade };
}
