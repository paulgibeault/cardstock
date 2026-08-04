// cardstock sound pack — the game's own sound design.
//
// Loaded as a plain script after /arcade-audio.js, before the module graph.
// src/arcade/audio.js registers everything here with Arcade.audio; the
// launcher's tools/soundpack renderer loads this same file to produce audition
// WAVs, so what gets approved by ear is what plays.
//
// ── a table with other people at it ──────────────────────────────────────
// The brief, and the thing that separates this pack from its nearest sibling:
// cozy-solitaire is ONE pair of hands in a small panelled room, and cardstock
// is FOUR PLAYERS around a table in a plainer, larger one. Same material —
// cardstock on felt on wood — read from a different distance.
//
// DISTANCE IS THE WHOLE DESIGN. The single most important thing a player has
// to hear is *whose turn just happened*, and that is carried by space rather
// than by pitch or by a different gesture: `play` is your own hand, dry and
// close and bright; `play-far` is the identical landing, duller, quieter and
// sitting in three times the room. Nobody has to learn what it means. Do not
// "fix" play-far by giving it its own timbre — the point is that it is the
// same card, further away.
//
// UNPITCHED, WITH ONE EXCEPTION. Nothing mid-hand is an instrument: dealing,
// playing, drawing and reshuffling are all sheet, felt and table. Pitch enters
// exactly once, at `win`, because an ending is allowed to be an instrument
// where a move is not. That boundary is the pack's identity; do not smudge it
// by giving some mid-game cue a note.
//
// Seven cues:
//
//   deal        a hand goes out           a riffle, then cards round the table
//   play        you play a card           felt, table, done
//   play-far    an opponent plays         the same landing, across the table
//   draw        a card off the stock      a slide, with nothing landing
//   shuffle     the discard is recycled   a packet riffled and squared
//   invalid     the move is refused       a dull scrape and a droop
//   win         the hand is out           three rising notes, then the deck away
//
// Register plan, so simultaneous cues occupy different bands:
//   table/thump 55–300 · felt landing 480–1050 · card body 900–2400
//   riffle 950–2000 · snaps 1500–4200 · win notes 400–1600
//
// Every cue takes an `r` (seeded random stream) and varies pitch, timing and
// content per play — but NEVER LEVEL. That rule is inherited from the fleet,
// not rediscovered here: `flaps` and `count` are texture controls, and the
// flex element is peak-normalised per sheet precisely so they cannot become
// hidden volume controls. Retune levels in the constants block, never inside
// a cue.

(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;

  // With the element library absent — a stale service-worker cache, or a
  // standalone embed off the launcher origin — there is nothing registrable
  // and the game plays silence, by design (fleet policy: a pack-based game
  // does not degrade to chiptune). Bail before dereferencing S; this is a
  // plain script and a throw here would surface as a page error even though
  // the silence itself is intended. Also covers an older library that predates
  // registerPack, which is the same scenario one version on.
  if (!S || typeof S.registerPack !== 'function') return;

  // A plainer, larger room than the solitaire parlour: a dining table rather
  // than a card table, less soft furnishing, more air. The longer tail is what
  // gives `play-far` somewhere to be far away IN.
  const ROOM = {
    dur: 1.05,
    decay: 0.30,
    preDelay: 0.014,
    wet: 0.30,
    shelfHz: 4200,
    shelfDb: -5,
    seed: 8291,
  };

  // How much room each cue sits in — really a statement about distance. Your
  // own hands are on the table, so `play` and `draw` are nearly dry;
  // `play-far` is the same gesture at three times the send, which is the
  // entire opponent-vs-you signal.
  const SENDS = {
    'deal': 0.13,
    'play': 0.06,
    'play-far': 0.17,
    'draw': 0.06,
    'shuffle': 0.12,
    'invalid': 0.07,
    'win': 0.19,
  };

  // Levels, by role. Balanced as a set — retune here, not inside a cue.
  // TOUCH is the reference: it is what the player hears thousands of times,
  // and everything else is placed relative to it. The value is the fleet's,
  // arrived at by ear in cozy-solitaire and kept so the two games sit at the
  // same loudness when a player moves between them.
  const TOUCH = 0.068;    // your card onto the pile — the reference level
  const FAR = 0.042;      // the same card, across the table
  const SLIDE = 0.052;    // a card off the stock; half a gesture and feels it
  const NO = 0.110;       // refused — present, never a buzzer
  const SHEET = 0.088;    // per sheet in a riffle; many of them at once
  const FANFARE = 0.140;  // one note of the ending

  // ── materials ─────────────────────────────────────────────────────────
  // One physical object, two angles: the sheet itself (riffled, slid, dealt)
  // and the sheet meeting the table (a landing). FELT is dark, dead and low;
  // CARD is defined and bright.
  const FELT = { stiffness: 0.40, f0: 780, snap: 0.42, flaps: 3 };
  const CARD = { stiffness: 0.84, f0: 1520, snap: 0.78, flaps: 4 };

  const seed = (r) => (r() * 1e6) | 0;

  /**
   * A card arriving on a pile: the contact, the sheet settling, and the table
   * taking the weight. Any one of the three alone reads as a synth — a landing
   * is three things arriving together.
   *
   * `far` (0..1) is distance, and it is one parameter on purpose: crossing the
   * table darkens the sheet, softens the snap and drops the level together,
   * the way distance actually works. The send is applied per-cue, outside.
   */
  function land(ctx, o, t, r, far) {
    const d = far || 0;
    const g = TOUCH + (FAR - TOUCH) * d;
    const dark = 1 - 0.34 * d;

    S.strike(ctx, o, t, {
      dur: S.between(r, 0.003, 0.005),
      hp: S.between(r, 2300, 2850) * dark,
      gain: g * 0.45 * (1 - 0.35 * d),
      seed: seed(r),
    });
    S.flex(ctx, o, t + 0.001, {
      dur: S.between(r, 0.055, 0.070),
      flaps: FELT.flaps, accel: 2.4,
      stiffness: FELT.stiffness,
      f0: FELT.f0 * S.cents(r, 110) * dark,
      snap: FELT.snap * (1 - 0.4 * d),
      gain: g,
      seed: seed(r),
    });
    S.thump(ctx, o, t + S.between(r, 0.004, 0.009), {
      f0: S.between(r, 86, 96), f1: S.between(r, 62, 70),
      dur: S.between(r, 0.055, 0.072), attack: 0.012,
      gain: g * 0.30 * (1 - 0.2 * d),
      seed: seed(r),
    });
    return 0.26;
  }

  const CUES = {
    // A hand goes out. The one flourish in the game, and the only cue with a
    // shape rather than a moment: the deck is riffled once (accelerating —
    // `end` below 1 tightens the spacing), then cards go round the table
    // (decelerating, because the last card of a deal always lands slower than
    // the first), then the stock is set down.
    'deal': function (ctx, o, t, params, r) {
      const seats = Math.max(2, Math.min(8, (params && params.seats) || 3));
      S.flex(ctx, o, t, {
        count: 16, rate: 34, end: 0.72,
        dur: 0.030, flaps: 2, accel: 1.6,
        stiffness: CARD.stiffness, f0: CARD.f0 * S.cents(r, 90),
        snap: CARD.snap * 0.7, gain: SHEET, seed: seed(r),
      });
      const roundStart = t + 0.52;
      S.flex(ctx, o, roundStart, {
        count: seats * 2, rate: 9, end: 1.45,
        dur: 0.048, flaps: 3, accel: 2.0,
        stiffness: FELT.stiffness + 0.2, f0: 980 * S.cents(r, 120),
        snap: 0.55, gain: SHEET * 0.85, seed: seed(r),
      });
      const settle = roundStart + (seats * 2) / 9 + 0.12;
      land(ctx, o, settle, r, 0.25);
      return settle + 0.3 - t;
    },

    // You play a card. The workhorse — deliberately the least characterful
    // thing in the game, because it fires more than everything else combined.
    // Variation ranges stay narrow; level does not move at all.
    'play': function (ctx, o, t, params, r) {
      return land(ctx, o, t, r, 0);
    },

    // An opponent plays. Identical gesture, across the table. See the header:
    // this is space, not timbre, and that is the point.
    'play-far': function (ctx, o, t, params, r) {
      return land(ctx, o, t, r, 1);
    },

    // A card off the stock. A slide, not a landing — the card leaves the pile
    // and arrives in a hand, and a hand is not a surface. No thump for exactly
    // that reason: nothing hit the table.
    'draw': function (ctx, o, t, params, r) {
      S.flex(ctx, o, t, {
        dur: S.between(r, 0.075, 0.095),
        flaps: 2, accel: 1.2,
        stiffness: 0.55, f0: S.between(r, 1050, 1250),
        snap: 0.22, lp: 3200,
        gain: SLIDE, seed: seed(r),
      });
      return 0.16;
    },

    // The discard is turned over and becomes the new stock. A packet riffled,
    // then squared against the table — the squaring decelerates (`end` above
    // 1), which is what makes it read as settling rather than as more riffle.
    'shuffle': function (ctx, o, t, params, r) {
      S.flex(ctx, o, t, {
        count: 20, rate: 36, end: 0.8,
        dur: 0.028, flaps: 2, accel: 1.5,
        stiffness: CARD.stiffness, f0: CARD.f0 * S.cents(r, 100),
        snap: CARD.snap * 0.65, gain: SHEET, seed: seed(r),
      });
      const square = t + 20 / 36 + 0.06;
      S.flex(ctx, o, square, {
        count: 3, rate: 7, end: 1.7,
        dur: 0.055, flaps: 3, accel: 2.2,
        stiffness: FELT.stiffness, f0: FELT.f0 * S.cents(r, 90),
        snap: 0.5, gain: SHEET * 0.9, seed: seed(r),
      });
      S.thump(ctx, o, square + 0.30, {
        f0: 78, f1: 56, dur: 0.09, attack: 0.014,
        gain: TOUCH * 0.34, seed: seed(r),
      });
      return square + 0.5 - t;
    },

    // Refused. The one gesture in the game with no ring in it at all: a dull
    // edgeless scrape, then a droop. Falling is over — the fleet's contour
    // grammar, unchanged.
    'invalid': function (ctx, o, t, params, r) {
      S.flex(ctx, o, t, {
        dur: 0.115, flaps: 5, accel: 0.8,
        stiffness: 0.16, f0: S.between(r, 420, 500),
        snap: 0.10, lp: 1400,
        gain: NO, seed: seed(r),
      });
      S.thump(ctx, o, t + 0.045, {
        f0: 168, f1: 96, dur: 0.20, attack: 0.016,
        gain: NO * 0.42, seed: seed(r),
      });
      return 0.32;
    },

    // The hand is out. The pack's one pitched moment (see the header): three
    // rising notes on `pluck`, then the deck set down on the table so the cue
    // ends on the same material everything else is made of, rather than
    // floating off on a chord.
    'win': function (ctx, o, t, params, r) {
      const root = 392 * S.cents(r, 20); // G4, give or take
      [0, 4, 7].forEach(function (semis, i) {
        S.pluck(ctx, o, t + i * 0.13, {
          freq: root * Math.pow(2, semis / 12),
          dur: 1.15 - i * 0.12, damping: 0.42, tone: 2600,
          gain: FANFARE * (1 - i * 0.08), seed: seed(r),
        });
      });
      land(ctx, o, t + 0.58, r, 0.4);
      return 1.9;
    },
  };

  // Publish under the well-known handle (arcade-audio.js registerPack) so the
  // game's audio module and the launcher's offline audition renderer load the
  // exact same file.
  S.registerPack({ name: 'cardstock', ROOM, SENDS, CUES });
})(typeof window !== 'undefined' ? window : globalThis);
