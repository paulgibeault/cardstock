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

// The cue names are NOT listed here. They were, and the list had already
// drifted behind the pack — a cue added to js/soundpack.js played nothing until
// somebody remembered to name it in a second place, with no error to say so.
// The pack's own CUES object is the list, so registration walks that.
//
// The gestures the pack is built FROM are a different question and stay
// hand-written: this is a capability probe, not a mirror. A cached older
// library may have graph() and el() but not these, and a missing element throws
// from inside a cue at play time — a cue that half-plays is worse than silence,
// so registration is gated on the pack's real dependencies rather than a
// version number.
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
  for (const [name, cue] of Object.entries(pack.CUES || {})) {
    if (typeof cue === 'function') a.graph(name, cue, { send: pack.SENDS[name] });
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
 * A trick being gathered off the table — now its OWN cue rather than a
 * borrowed one.
 *
 * It used to map onto 'shuffle' for a clean trick and 'invalid' for a pointed
 * one, which was wrong in a way players could hear: `shuffle` means the discard
 * pile was recycled, so every trick won announced a reshuffle that had not
 * happened, and `invalid` means the game refused your move. The pack now has a
 * `trick` cue (js/soundpack.js) and `bad` is a parameter of it, so a painful
 * trick is the same gesture darkened rather than a different event entirely.
 */
export function playTrickTaken({ bad = false } = {}) { sfx('trick', { bad }); }

/**
 * An announcement landing — a last-card call, or somebody being caught not
 * making one (§E2).
 *
 * Deliberately NOT a new cue. A declaration is a player asserting something
 * about the table, which is the same punctuation a closing trick is, and being
 * caught is the game refusing you — which is exactly what `invalid` says. The
 * pack gains a cue when a cue is DESIGNED, never because a call site wanted one.
 */
export function playAnnouncement({ caught = false } = {}) {
  sfx(caught ? 'invalid' : 'trick', caught ? undefined : { bad: false });
}

/**
 * An action card landing on somebody — a skip, a reverse, a Draw 2 or 4.
 *
 * Same discipline as playAnnouncement: no new cue, because none has been
 * designed. `trick` is the pack's punctuation gesture, the sound of the table
 * turning over, which is what all three of these are; `bad` darkens it, and
 * whether an action card is bad is entirely a question of who it happened to.
 * So the parameter is "did this land on ME", and a Draw 4 sounds like a Draw 4
 * from the other side of the table.
 */
export function playActionCard({ against = false } = {}) {
  sfx('trick', { bad: against });
}
