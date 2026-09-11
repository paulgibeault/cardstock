// The new-game sheet: house rules and seat count, asked before the deal.
//
// BOTH CHOICES ARE PART OF THE RULE SET, which is why they are asked here and
// nowhere else. A match persists as seed + event log and re-hydrates by
// replaying the reducer (src/engine/replay.js), so the variants and the number
// of seats are inputs the replay must be given exactly as they were — change
// either mid-match and every card after the change deals differently. Storage
// already pins them per match; what was missing was any way for a player to
// pick them, which is the deferred "L4 new-game sheet" in LOBBY_PLAN.md.
//
// The variant machinery itself is entirely in the pack: `manifest.variants`
// declares each one with its own prose and a patch of dotted rule paths, and
// packLoader applies them. So a house rule is a manifest entry, not a code
// change, and this sheet renders whatever a pack declares without knowing what
// any of them mean.
//
// HOW HARD THE BOTS PLAY IS THE ONE THING HERE THAT IS NOT A RULE, and it is
// asked here anyway because this is the moment a player is already deciding
// what kind of game they want. It is a PREFERENCE, not an input to the deal:
// it never reaches the reducer, a replay never re-runs the chooser
// (src/engine/bot.js), and so — unlike the seat count and the house rules — it
// is remembered globally and may be changed for the next hand without making
// this one unreplayable. The sheet reads the saved value and hands the answer
// back; src/ui/lobby.js is what writes it, so backing out changes nothing.

import { SKILL_LEVELS, skillLevel } from './difficulty.js';
import { PACE_LEVELS, paceLevel } from './pace.js';
import { SPEED_LEVELS, speedLevel, speedForDelay } from './speed.js';
import { loadSettings } from '../arcade/storage.js';

const el = {
  overlay: document.getElementById('new-game-overlay'),
  title: document.getElementById('new-game-title'),
  body: document.getElementById('new-game-body'),
  deal: document.getElementById('new-game-deal'),
  cancel: document.getElementById('new-game-cancel'),
};

let resolveOpen = null;

function close(value) {
  el.overlay.hidden = true;
  el.body.replaceChildren();
  const resolve = resolveOpen;
  resolveOpen = null;
  if (resolve) resolve(value);
}

function field(labelText, control, description) {
  const row = document.createElement('label');
  row.className = 'new-game__row';
  row.appendChild(control);
  const text = document.createElement('span');
  text.className = 'new-game__text';
  const name = document.createElement('span');
  name.className = 'new-game__name';
  name.textContent = labelText;
  text.appendChild(name);
  if (description) {
    const desc = document.createElement('span');
    desc.className = 'new-game__desc';
    // textContent: variant prose is pack-supplied.
    desc.textContent = description;
    text.appendChild(desc);
  }
  row.appendChild(text);
  return row;
}

function heading(text) {
  const h = document.createElement('h3');
  h.className = 'new-game__heading';
  h.textContent = text;
  return h;
}

/**
 * Does this pack have anything worth asking about?
 *
 * A sheet with one fixed seat count and no variants is a dialog whose only
 * honest button is "Deal", and putting one in front of every game would make
 * starting one slower for no decision gained.
 *
 * The bot difficulty below does NOT open this gate, deliberately. It is a
 * remembered preference rather than a property of the deal, so a pack with
 * nothing else to ask plays at whatever was last chosen instead of stopping to
 * ask again. Every pack shipped today offers a seat range, so every one of them
 * shows the row.
 */
export function hasChoices(manifest) {
  const players = manifest.players || {};
  const seatRange = (players.max ?? 0) > (players.min ?? 0);
  return seatRange || offeredVariants(manifest).length > 0;
}

/**
 * The variants a player may actually switch on.
 *
 * A pack may declare a house rule its template has not built yet — Wildfire
 * says stacking and jump-in, and means it, but no code reads either flag. That
 * declaration is worth keeping as a statement of intent and must NOT reach
 * this sheet: a rule you can tick that changes nothing about the game is worse
 * than one that is not offered, because the player believes it.
 */
function offeredVariants(manifest) {
  return (manifest.variants || []).filter((v) => v.available !== false);
}

/**
 * Ask for this game's setup.
 *
 * @param manifest the pack's manifest (the lobby holds these; no deck needed).
 * @returns { variants: string[], seats: number, difficulty: string,
 *            pace: string, speed: string } or null if the player backed out.
 *            `speed` is a rung id (src/ui/speed.js), not the millisecond
 *            value it stands for — the lobby does that translation.
 */
export function askNewGame(manifest) {
  const players = manifest.players || {};
  const min = players.min ?? 2;
  const max = players.max ?? 8;
  // The pack's own recommendation, clamped — a "best" outside the declared
  // range is a manifest bug that should not become a table nobody can seat.
  const preferred = Math.max(min, Math.min(max, players.best ?? 3));

  el.title.textContent = `New ${manifest.name} game`;
  el.body.replaceChildren();

  let seats = preferred;
  if (max > min) {
    el.body.appendChild(heading('Players'));
    const row = document.createElement('div');
    row.className = 'new-game__seats';
    const output = document.createElement('span');
    output.className = 'new-game__seat-count';
    const paint = () => {
      // AND WHAT THAT SEAT COUNT CHANGES, where the pack has something to say
      // about it (`players.notes`). Thirteen at two seats is not the same deal
      // as Thirteen at four — three face-down hands of seventeen that you pick
      // from, rather than thirteen each (#157) — and the button is where that
      // is decided, so it is where it has to be said. A pack with no note for
      // this count gets the sentence it always had.
      const note = manifest.players?.notes?.[String(seats)];
      output.textContent = `${seats} players — you and ${seats - 1} ${seats === 2 ? 'bot' : 'bots'}`
        + (note ? `. ${note}` : '');
    };
    for (let n = min; n <= max; n++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'new-game__seat';
      btn.textContent = String(n);
      btn.setAttribute('aria-pressed', String(n === seats));
      btn.addEventListener('click', () => {
        seats = n;
        for (const other of row.querySelectorAll('.new-game__seat')) {
          other.setAttribute('aria-pressed', String(Number(other.textContent) === seats));
        }
        paint();
      });
      row.appendChild(btn);
    }
    el.body.appendChild(row);
    paint();
    el.body.appendChild(output);
  }

  const variants = offeredVariants(manifest);
  const boxes = new Map();
  if (variants.length) {
    el.body.appendChild(heading('House rules'));
    for (const variant of variants) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'new-game__check';
      box.checked = variant.default === true;
      boxes.set(variant.id, box);
      el.body.appendChild(field(variant.name || variant.id, box, variant.description));
    }
  }

  // A SEGMENTED ROW RATHER THAN A DROPDOWN, matching the seat count directly
  // above it: three options is fewer than the seat picker already shows, and a
  // select would hide two thirds of the choice behind a tap.
  el.body.appendChild(heading('Opponents'));
  let difficulty = skillLevel(loadSettings().botDifficulty).id;
  const skills = document.createElement('div');
  skills.className = 'new-game__skills';
  const skillDesc = document.createElement('span');
  skillDesc.className = 'new-game__seat-count';
  const paintSkill = () => {
    skillDesc.textContent = skillLevel(difficulty).description;
    for (const btn of skills.querySelectorAll('.new-game__skill')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.skill === difficulty));
    }
  };
  for (const level of SKILL_LEVELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'new-game__skill';
    btn.dataset.skill = level.id;
    btn.textContent = level.label;
    btn.addEventListener('click', () => {
      difficulty = level.id;
      paintSkill();
    });
    skills.appendChild(btn);
  }
  el.body.appendChild(skills);
  el.body.appendChild(skillDesc);
  paintSkill();

  // THE FOURTH ROW, and the same shape as the third for the same reason: four
  // named rungs is a choice you make by looking at it, and the thing it
  // replaces — a millisecond count in a text field — is a question nobody has
  // an answer to. Like the difficulty above it this is a PREFERENCE rather than
  // an input to the deal: it never reaches the reducer, so changing it mid-match
  // (which the round summary's own control does) costs the replay nothing.
  el.body.appendChild(heading('Between hands'));
  let pace = paceLevel(loadSettings().pace).id;
  const paces = document.createElement('div');
  paces.className = 'new-game__skills';
  const paceDesc = document.createElement('span');
  paceDesc.className = 'new-game__seat-count';
  const paintPace = () => {
    paceDesc.textContent = paceLevel(pace).description;
    for (const btn of paces.querySelectorAll('.new-game__pace')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.pace === pace));
    }
  };
  for (const level of PACE_LEVELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'new-game__skill new-game__pace';
    btn.dataset.pace = level.id;
    btn.textContent = level.label;
    btn.addEventListener('click', () => {
      pace = level.id;
      paintPace();
    });
    paces.appendChild(btn);
  }
  el.body.appendChild(paces);
  el.body.appendChild(paceDesc);
  paintPace();

  // THE FIFTH ROW, and the other half of pacing (#175). "Between hands" above
  // is how long the table waits once a hand is over; this is how fast a card
  // moves while one is being played, and the pace rungs deliberately cannot
  // touch it — src/ui/roundBeat.js measures its hold AGAINST the flight, so no
  // pace a player picks has ever slowed a card down.
  //
  // THE ANSWER IS A RUNG ID AND THE SETTING IS A NUMBER. This row hands back
  // the id; src/ui/lobby.js maps it to `botDelayMs` on the gesture that deals,
  // the same as everything else here. A preference, not an input to the deal:
  // the chooser is never re-run by a replay, so the status bar may change it
  // mid-match for free.
  el.body.appendChild(heading('Card speed'));
  let speed = speedForDelay(loadSettings().botDelayMs).id;
  const speeds = document.createElement('div');
  speeds.className = 'new-game__skills';
  const speedDesc = document.createElement('span');
  speedDesc.className = 'new-game__seat-count';
  const paintSpeed = () => {
    speedDesc.textContent = speedLevel(speed).description;
    for (const btn of speeds.querySelectorAll('.new-game__speed')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.speed === speed));
    }
  };
  for (const level of SPEED_LEVELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'new-game__skill new-game__speed';
    btn.dataset.speed = level.id;
    btn.textContent = level.label;
    btn.addEventListener('click', () => {
      speed = level.id;
      paintSpeed();
    });
    speeds.appendChild(btn);
  }
  el.body.appendChild(speeds);
  el.body.appendChild(speedDesc);
  paintSpeed();

  el.overlay.hidden = false;
  el.deal.focus({ preventScroll: true });

  return new Promise((resolve) => {
    resolveOpen = resolve;
    el.deal.onclick = () => close({
      seats,
      variants: [...boxes.entries()].filter(([, box]) => box.checked).map(([id]) => id),
      difficulty,
      pace,
      speed,
    });
    el.cancel.onclick = () => close(null);
  });
}

/** Shut the sheet without dealing — for a screen change under an open one. */
export function closeNewGame() {
  if (!el.overlay.hidden) close(null);
}
