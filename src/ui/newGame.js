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
 * @returns { variants: string[], seats: number } or null if the player backed out.
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
      output.textContent = `${seats} players — you and ${seats - 1} ${seats === 2 ? 'bot' : 'bots'}`;
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

  el.overlay.hidden = false;
  el.deal.focus({ preventScroll: true });

  return new Promise((resolve) => {
    resolveOpen = resolve;
    el.deal.onclick = () => close({
      seats,
      variants: [...boxes.entries()].filter(([, box]) => box.checked).map(([id]) => id),
    });
    el.cancel.onclick = () => close(null);
  });
}

/** Shut the sheet without dealing — for a screen change under an open one. */
export function closeNewGame() {
  if (!el.overlay.hidden) close(null);
}
