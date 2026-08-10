// The contract ladder: every rung of the race, and who is standing on it.
//
// Contract-rummy's per-player progression is the whole game (design doc §13.3)
// and it used to be a two-character chip on a name plate — you could see that
// Nell was on "Ph 3" but not what phase 3 asks for, how many rungs are left, or
// how far ahead of you she is.
//
// DATA-DRIVEN, so it appears for any pack declaring `rules.contracts` and stays
// hidden for everything else. Its own file because it is a hundred lines of one
// widget, and because it owns a media-query watcher whose lifetime is the
// screen's rather than a match's.

import { line } from './dom.js';
import { ladderRungs, describeContract, describeContractItem, shortContract, CONTRACT_LADDER_KEY } from './interaction.js';

/**
 * @param el          the #contract-ladder element
 * @param me          the seat lens (src/players/seats.js) — whose rung is "mine"
 * @param identityOf  (seat) => roster identity
 * @param attachInspector (node, describe, opts) => void
 * @param isBusy      () => true while a drag owns the pointer
 */
export function createContractLadder({ el, me, identityOf, attachInspector, isBusy }) {
  /**
   * The contract ladder: every rung of the race, and who is standing on it.
   *
   * Contract-rummy's per-player progression is the whole game (design doc
   * §13.3) and it used to be a two-character chip on a name plate — you could
   * see that Nell was on "Ph 3" but not what phase 3 asks for, how many rungs
   * are left, or how far ahead of you she is. Data-driven, so it appears for any
   * pack declaring `rules.contracts` and stays hidden for everything else.
   *
   * Rungs carry the SHORT form (`S3+R4`) with a one-line key, and hovering gives
   * the sentence — the same words-versus-badge split the pile labels use.
   */
  /**
   * How many ladder rungs the row can hold at this width.
   *
   * Read from the same breakpoints table.css sizes the rungs at, rather than
   * measured: a measurement here would be a forced layout on every render, and
   * the widths that matter are exactly the ones the stylesheet already names.
   * A desktop row fits the whole course, so it gets it — truncation is a
   * response to a narrow screen, not the ladder's preference.
   */
  /**
   * How many rungs there is room for.
   *
   * ASKED OF THE HEIGHT, because the ladder is a column now (it stands beside
   * the piles rather than across the felt — see #felt-middle). Keyed on width
   * it answered the wrong question entirely: a narrow phone held in portrait
   * is the case with the MOST vertical room for a stack of rungs, and it was
   * the case the old budget truncated hardest.
   */
  function ladderBudget() {
    if (typeof window.matchMedia !== 'function') return 6;
    if (window.matchMedia('(max-height: 620px)').matches) return 5;
    if (window.matchMedia('(max-height: 800px)').matches) return 7;
    return Infinity;
  }

  function render(state) {
    const contracts = state.pack.rules.contracts;
    if (!Array.isArray(contracts) || !contracts.length) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }

    const minePhase = state.playerVars[me.seat()]?.phase ?? null;
    el.replaceChildren();

    // Which rungs survive the squeeze, and where the collapsed runs go — see
    // ladderRungs in src/ui/interaction.js for what may be dropped and why.
    const occupied = [];
    for (let seat = 0; seat < state.seats; seat++) {
      const phase = state.playerVars[seat]?.phase ?? null;
      if (phase) occupied.push(phase);
    }

    for (const entry of ladderRungs(contracts.length, { minePhase, occupied, maxRungs: ladderBudget() })) {
      if (entry.kind === 'gap') {
        const span = entry.to - entry.from + 1;
        const where = span === 1 ? `Contract ${entry.from}` : `Contracts ${entry.from}–${entry.to}`;
        const gap = document.createElement('div');
        gap.className = 'ladder__gap';
        gap.appendChild(line('ladder__gap-mark', '⋯'));

        // ANYONE THE SQUEEZE HID IS DRAWN HERE. Collapsing a rung is only safe
        // because the players standing on it come with it — "who is behind me"
        // survives at coarser resolution rather than vanishing.
        const inside = [];
        for (let seat = 0; seat < state.seats; seat++) {
          const phase = state.playerVars[seat]?.phase ?? null;
          if (phase === null || phase < entry.from || phase > entry.to) continue;
          const identity = identityOf(seat);
          inside.push(identity);
          const pip = document.createElement('span');
          pip.className = 'ladder__pip ladder__pip--tucked';
          pip.style.background = identity.color;
          pip.textContent = identity.icon || identity.initials;
          pip.setAttribute('aria-hidden', 'true');
          gap.appendChild(pip);
        }

        const names = inside.map((i) => (me.holds(i.seat) ? 'you' : i.name));
        gap.setAttribute('aria-label', `${where}.`
          + (names.length ? ` On them: ${names.join(', ')}.` : ' Nobody is on them.'));
        attachInspector(gap, () => ({
          title: where,
          lines: contracts.slice(entry.from - 1, entry.to).map((items, n) => ({
            label: String(entry.from + n), value: describeContract(items),
          })),
          notes: names.length ? [`Currently on these: ${names.join(', ')}.`] : ['Nobody is on these yet.'],
        }), { isBusy });
        el.appendChild(gap);
        continue;
      }

      const phase = entry.phase;
      const items = contracts[phase - 1];
      const rung = document.createElement('div');
      const mine = phase === minePhase;
      rung.className = `ladder__rung ${mine ? 'ladder__rung--mine' : ''} `
        + `${minePhase && phase < minePhase ? 'ladder__rung--past' : ''}`;

      rung.appendChild(line('ladder__no', String(phase)));
      rung.appendChild(line('ladder__req', shortContract(items)));

      const who = document.createElement('div');
      who.className = 'ladder__who';
      const here = [];
      for (let seat = 0; seat < state.seats; seat++) {
        if ((state.playerVars[seat]?.phase ?? null) !== phase) continue;
        const identity = identityOf(seat);
        here.push(identity);
        const pip = document.createElement('span');
        pip.className = 'ladder__pip';
        // Roster colour — an own value, never a manifest one (§7b).
        pip.style.background = identity.color;
        pip.textContent = identity.icon || identity.initials;
        pip.setAttribute('aria-hidden', 'true');
        who.appendChild(pip);
      }
      rung.appendChild(who);

      const names = here.map((i) => (me.holds(i.seat) ? 'you' : i.name));
      rung.setAttribute('aria-label',
        `Contract ${phase} of ${contracts.length}: ${describeContract(items)}.`
        + (names.length ? ` On it: ${names.join(', ')}.` : ' Nobody is on it.'));

      attachInspector(rung, () => ({
        title: `Contract ${phase}`,
        lines: items.map((item, n) => ({ label: `Part ${n + 1}`, value: describeContractItem(item) })),
        notes: names.length
          ? [`Currently on it: ${names.join(', ')}.`]
          : ['Nobody is on this contract.'],
      }), { isBusy });

      el.appendChild(rung);
    }

    el.appendChild(line('ladder__key', CONTRACT_LADDER_KEY));
    el.hidden = false;
  }

  /**
   * Re-draw the ladder when the window crosses a width where it holds a
   * different number of rungs. Only the ladder: everything else on the felt
   * resizes through CSS variables and needs no help.
   */
  function watch(getState) {
    if (typeof window.matchMedia !== 'function') return;
    let budget = ladderBudget();
    const recheck = () => {
      const next = ladderBudget();
      if (next === budget) return;
      budget = next;
      if (getState()) render(getState());
    };
    for (const query of ['(max-width: 420px)', '(max-width: 720px)']) {
      const mq = window.matchMedia(query);
      if (mq.addEventListener) mq.addEventListener('change', recheck);
      else if (mq.addListener) mq.addListener(recheck);
    }
  }

  return { render, watch, hide };

  function hide() {
    el.hidden = true;
    el.replaceChildren();
  }
}
