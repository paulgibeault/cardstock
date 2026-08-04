// The game's single audio registration site, via the SDK's `Arcade.audio`.
//
// THE PACK IS THE SOUND. js/soundpack.js holds the whole design — which
// gestures, how loud, how far away. Every cue there is a node graph built from
// the launcher's shared element library, and every cue feeds one convolution
// room, which is what makes overlapping sounds fuse into a table instead of
// stacking into a pile. Do not retune the pack from here.
//
// NO SYNTHESIS LIVES IN THIS GAME. A gesture cardstock needs and the library
// lacks belongs in the library, not in the pack — that is how `flex` (a thin
// springy sheet bent and released: paper, cardstock, a flag) got there, and
// why this game got it for free.
//
// THERE IS NO FALLBACK. When the pack cannot register — an older cached SDK,
// or standalone without /arcade-audio.js — this module registers nothing and
// the game is silent. That is fleet policy, not an oversight: a chiptune
// approximation of a pack is worse than nothing, and silence on a stale cache
// is expected, so it is not logged.
//
// Conventions (GAME_INTEGRATION §5):
//   A1 — cues register ONCE, at module load. Audio is purely local, so no
//        `await Arcade.ready` is needed.
//   A2 — every play site goes through a wrapper below, which is a pure feature
//        detect and must never throw; these are called from the input path.
//   A3 — the launcher owns volume and the global mute. This module adds no
//        control of its own, and connects nothing to ctx.destination — a
//        custom node would have to go to Arcade.audio.bus() to obey them.
//   A4 — cue names are lowercase and event-shaped.

const CUE_NAMES = ['deal', 'play', 'play-far', 'draw', 'shuffle', 'invalid', 'win'];

// The gestures the pack is actually built from. A cached older library may
// have graph() and el() but not these, and a missing element throws from
// inside a cue at play time — a cue that half-plays is worse than silence, so
// registration is gated on the pack's real dependencies rather than a version.
const NEEDED_ELEMENTS = ['flex', 'strike', 'thump', 'pluck', 'cents', 'between'];

function audio() {
  return (typeof window !== 'undefined' && window.Arcade && window.Arcade.audio)
    ? window.Arcade.audio
    : null;
}

function sfx(name, params) {
  const a = audio();
  if (a) a.play(name, params);
}

let graphMode = false;

(function registerCues() {
  const a = audio();
  const pack = (typeof window !== 'undefined' && window.ArcadeSoundPack) || null;
  if (!a || !pack) return;

  const el = typeof a.el === 'function' ? a.el() : null;
  const graphable =
    typeof a.graph === 'function' &&
    typeof a.room === 'function' &&
    el !== null &&
    NEEDED_ELEMENTS.every((name) => typeof el[name] === 'function');
  if (!graphable) return;

  a.room(pack.ROOM);
  for (const name of CUE_NAMES) {
    if (pack.CUES[name]) a.graph(name, pack.CUES[name], { send: pack.SENDS[name] });
  }
  graphMode = true;
})();

/** True when the graph pack registered. Diagnostics only — no call site branches on it. */
export function isGraphMode() { return graphMode; }

/** `seats` shapes how many cards go round the table in the deal flourish. */
export function playDeal(seats) { sfx('deal', { seats }); }

/**
 * A card landing. `far` is the whole opponent-vs-you signal — the same
 * gesture, across the table — so pass it honestly rather than playing the
 * close cue for everyone.
 */
export function playCardPlayed({ far }) { sfx(far ? 'play-far' : 'play'); }

export function playDraw() { sfx('draw'); }
export function playShuffle() { sfx('shuffle'); }
export function playInvalid() { sfx('invalid'); }
export function playWin() { sfx('win'); }

/**
 * A trick being gathered off the table. Mapped onto existing pack cues — the
 * sweep of cards is physically a shuffle gesture, and a trick full of penalty
 * points landing in YOUR pile earns the dull 'invalid' thud. A dedicated
 * gather cue belongs in js/soundpack.js if one is ever designed; per the
 * header, no synthesis is added here.
 */
export function playTrickTaken({ bad = false } = {}) { sfx(bad ? 'invalid' : 'shuffle'); }
