// The Definition-of-Done checklist for multiplayer (docs/plans/MULTIPLAYER_PLAN.md §11),
// one exported scenario per numbered item — plus the ones the checklist grew.
// 7 and 8 came from the hardening and rejoin work; 9 was the two-table case
// docs/plans/TABLES_PLAN.md §10 asked for and is now its opposite — one table per
// device (#285), the seat stepper (#284) and stale tiles clearing. 10 is the 2026-08-16 field test that
// produced the framework's open-game redesign, replayed from a cold start: the
// shape the party model got wrong, and the proof it no longer is. 11 is the
// 2026-10-03 playtest (#283): a guest sees the trick and the score sheet.
//
// Separated from tools/mp-acceptance.mjs on purpose: that file is the harness —
// three devices, three launchers, the game mounted and the caps gate satisfied
// — and this one is the list of things we promised those devices would do.
//
// Each scenario receives what the harness established:
//   check     the ✓/✗ recorder; every assertion goes through it
//   waitFor   bounded-deadline poll for cross-page convergence
//   pages     { H, A, B } — the three LAUNCHER pages
//   frames    { H, A, B } — the cardstock frame inside each
//   devices   { H, A, B } — the three device ids
//
// Inside a frame, `window.__mod('src/…')` imports the live module the game is
// running on (see the harness's installModuleLoader).
//
// TWO ITEMS ARE NOT AUTOMATED HERE, AND SAY SO RATHER THAN PASSING QUIETLY.
// Items 4 and 5 need to reach INSIDE the transport — cut a live data channel
// mid-hand, and force the replay queue's `overflowed` flag — and neither the
// SDK's peer surface nor the launcher's `startP2PHarness` exposes a way to do
// it from a test. Both behaviours ARE covered headlessly, against the same
// modules, in tests/protocol.test.js ("AN INTERRUPTED SEAT KEEPS PLAYING",
// "a replay queue that overflowed forces a snapshot on the next ready"), so
// what is missing is specifically the real-transport tier. They are reported as
// SKIP with that reason: a checklist that quietly drops the two hardest items
// is worse than one that admits to them.

const PACK = 'crazy-eights';
// The launcher's id for this game, which is what a SCOPE is keyed by — the
// packs above are cardstock's own word for what is being played on one. Two
// vocabularies, deliberately: "table" is this repo's and the framework never
// uses it (plans/tables-2026-08.md, Terminology).
const GAME = 'cardstock';

/* ------------------------------------------------------------------ *
 * Talking to the game
 * ------------------------------------------------------------------ */

/** Call an exported function of src/ui/party.js inside a frame. */
function party(frame, method, ...args) {
  return frame.evaluate(async ({ m, a }) => {
    const mod = await window.__mod('src/ui/party.js');
    return mod[m](...a);
  }, { m: method, a: args });
}

/** What the host's engine state actually says — the only authority there is. */
function hostState(frame) {
  return frame.evaluate(async () => {
    const table = await window.__mod('src/ui/table.js');
    const ctx = table.tableContext();
    if (!ctx) return null;
    return {
      moves: ctx.state.log.length,
      turn: ctx.state.turn.seat,
      round: ctx.state.roundNumber,
      over: !!ctx.state.gameOver,
      seats: ctx.state.seats,
    };
  });
}

/** Every card id a seat can see in its own view — a joiner's whole world. */
function viewCards(frame) {
  return frame.evaluate(async () => {
    const table = await window.__mod('src/ui/table.js');
    const ctx = table.tableContext();
    // `state.view` is the RAW ViewState the host sent (src/ui/tableModel.js
    // keeps it on the model). Reading the model's zone accessors instead would
    // be asking the renderer what it drew; this is asking what arrived.
    const view = ctx?.state?.isView ? ctx.state.view : null;
    if (!view) return null;
    const out = { seat: view.seat ?? null, zones: {} };
    for (const [address, zone] of Object.entries(view.zones || {})) {
      if (Array.isArray(zone.cards)) out.zones[address] = zone.cards.slice();
    }
    return out;
  });
}

const skip = (name, why) => console.log(`  ⊘ ${name} — SKIPPED: ${why}`);

/**
 * Host a game, ANSWERING the one-table question if it is asked (#285).
 *
 * `hostGame` awaits a confirm dialog when this device is already at a table,
 * and a scenario that only awaited it would hang on that dialog forever. So the
 * call, the wait for the dialog and the tap all happen in the page, and what
 * comes back says whether anything was asked and what.
 */
function hostGameAnswering(frame, packId, answer = true) {
  return frame.evaluate(async ({ packId: id, answer: yes }) => {
    const mod = await window.__mod('src/ui/party.js');
    const modal = document.getElementById('confirm-modal');
    let asked = null;
    const pending = mod.hostGame(id);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 100 && !settled; i++) {
      if (!modal.hidden) {
        asked = `${document.getElementById('confirm-message').textContent} ${document.getElementById('confirm-detail').textContent}`;
        document.getElementById(yes ? 'confirm-ok' : 'confirm-cancel').click();
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { result: await pending, asked };
  }, { packId, answer });
}

/** Tap OK (or Cancel) on the confirm dialog if one comes up within a moment. */
function answerIfAsked(frame, answer = true, withinMs = 1500) {
  return frame.evaluate(async ({ yes, ms }) => {
    const modal = document.getElementById('confirm-modal');
    for (let waited = 0; waited < ms; waited += 100) {
      if (!modal.hidden) {
        const asked = `${document.getElementById('confirm-message').textContent} ${document.getElementById('confirm-detail').textContent}`;
        document.getElementById(yes ? 'confirm-ok' : 'confirm-cancel').click();
        return asked;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, { yes: answer, ms: withinMs });
}

/* ------------------------------------------------------------------ *
 * 1. A scripted hand, end to end
 * ------------------------------------------------------------------ */

async function seatEverybody({ check, waitFor, frames }, packId = PACK) {
  // THE TABLE IS BUILT BEFORE IT IS DEALT. The host picks a game from a lobby
  // tile, everybody takes a chair, and the cards come out once — which is why
  // there is no bot holding a hand for a joiner to take it off.
  const hosted = await frames.H.evaluate(async (packId) => {
    const p = await window.__mod('src/ui/party.js');
    return p.hostGame(packId);
  }, packId);
  check('host: a lobby tile opens a party for that game', hosted === true);
  check('host: role is host before a single card is dealt',
    (await party(frames.H, 'partyRole')) === 'host');
  const preDeal = await hostState(frames.H);
  check('host: and there is genuinely no table yet', preDeal === null, JSON.stringify(preDeal));

  // The joiners have been listening the whole time: the invitation is a lobby
  // frame, believed only from the direct link and never when relayed. Sighting
  // one IS joining — the pack loads, the client starts, the seats go live.
  const seatOf = { A: 1, B: 2 };
  for (const label of ['A', 'B']) {
    const ready = await waitFor(async () => {
      await party(frames[label], 'refreshEntry');
      return (await party(frames[label], 'partyRole')) === 'joiner';
    }, 20000);
    check(`joiner ${label}: an invitation makes it a client, with no second tap`, ready);
  }

  // From here it is the real UI: the table's tile in the lobby, then the
  // seat's own claim (#286 — the tile is the door; the header button is gone).
  for (const label of ['A', 'B']) {
    await waitFor(() => frames[label].evaluate(() => !!document.querySelector('#tables-grid .table-tile')), 20000);
    await frames[label].evaluate(() => document.querySelector('#tables-grid .table-tile').click());
    const seat = seatOf[label];
    const offered = await waitFor(() => frames[label].evaluate(
      (s) => !!document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`), seat), 20000);
    check(`joiner ${label}: the seat grid offers seat ${seat}`, offered);
    await frames[label].evaluate(
      (s) => document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`).click(), seat);
  }

  // The host sees both claims land on the table it is about to deal.
  const filled = await waitFor(async () => {
    const seats = (await party(frames.H, 'partySnapshot')).seats;
    return seats.filter((s) => s.status === 'connected').length === 3;
  }, 20000);
  check('host: both joiners are seated before the deal', filled,
    JSON.stringify((await party(frames.H, 'partySnapshot')).seats));

  await frames.H.evaluate(async () => {
    const p = await window.__mod('src/ui/party.js');
    await p.dealParty();
  });

  for (const label of ['A', 'B']) {
    // WAIT FOR THE VIEW, WHICH IS WHAT THIS CHECK IS NAMED FOR. `seat` alone
    // stopped meaning "the deal arrived" once a client learned its seat from
    // the host's ROSTER (#49 part 4) — which is earlier, and correct: a seat
    // claimed at a table still being built is a real seat. Waiting on it alone
    // made the next line race the view it depends on.
    const seated = await waitFor(async () => {
      const snap = await party(frames[label], 'partySnapshot');
      return snap.seat === seatOf[label] && snap.seq >= 1;
    }, 20000);
    const snap = await party(frames[label], 'partySnapshot');
    check(`joiner ${label}: the deal arrives as a view of seat ${seatOf[label]}`, seated,
      `seat ${snap.seat}, seq ${snap.seq}`);
    const onTable = await frames[label].evaluate(() => !document.getElementById('table-screen').hidden);
    check(`joiner ${label}: the felt is on screen`, onTable);
  }

  // THE BUG THIS FLOW WAS BUILT AROUND: the host's bot driver used to move
  // every seat it did not itself hold, which at a shared table means the
  // joiners' seats. A seat somebody is sitting in must belong to them.
  const houseSeats = await frames.H.evaluate(async () => {
    const table = await window.__mod('src/ui/table.js');
    const ctx = table.tableContext();
    const out = [];
    for (let seat = 0; seat < ctx.seats.count; seat++) {
      if (ctx.seats.isBot(seat) || ctx.seats.isEmpty(seat)) out.push(seat);
    }
    return out;
  });
  check('the host plays no seat a person is sitting in',
    !houseSeats.includes(1) && !houseSeats.includes(2), `house plays ${houseSeats.join(',') || 'nothing'}`);

  return seatOf;
}

const scriptedHand = {
  title: 'a scripted hand, host + two joiners, end to end',
  async run(ctx) {
    const { check, waitFor, frames } = ctx;
    await seatEverybody(ctx);

    const before = await hostState(frames.H);
    check('the host holds the only state', before && before.moves >= 0, JSON.stringify(before));

    // Every device is asked, every round of the loop; only the seat whose turn
    // it is has anything to do. The host's own bot seats move on their own
    // clock, which is why this waits between passes rather than driving them.
    // PATIENCE IS LOAD-BEARING HERE. Only the seat whose turn it is has
    // anything to do, and when that seat is a BOT the answer arrives on the
    // bot's own think time — the better part of a second, deliberately, so a
    // table does not feel like a spreadsheet. An idle tolerance shorter than
    // one think time reads a thinking bot as a stalled table, which is exactly
    // what it did while there was no bot at the table to notice it with.
    let last = before.moves;
    let idle = 0;
    for (let i = 0; i < 600 && idle < 40; i++) {
      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* a frame mid-render */ }
      }
      const now = await hostState(frames.H);
      if (!now) break;
      if (now.moves === last) idle++; else { idle = 0; last = now.moves; }
      if (now.round > before.round || now.over) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const after = await hostState(frames.H);
    // Where the loop left the table. On a pass this is just trivia; on a
    // failure it is the whole diagnosis — whose turn it was, and whether that
    // seat is one the house was supposed to be moving.
    const restingOn = await frames.H.evaluate(async () => {
      const table = await window.__mod('src/ui/table.js');
      const ctx = table.tableContext();
      if (!ctx) return null;
      const seat = ctx.state.turn.seat;
      return {
        seat,
        phase: ctx.state.turn.phase,
        owner: ctx.seats.ownerOf(seat).kind,
        house: ctx.seats.isBot(seat) || ctx.seats.isEmpty(seat),
        panels: [...document.querySelectorAll('#round-overlay, #game-over-overlay, #choice-modal')]
          .filter((n) => !n.hidden).map((n) => n.id),
      };
    });
    check('the hand played out to the end of a round',
      !!after && (after.round > before.round || after.over),
      `${after?.moves} moves, round ${before.round} → ${after?.round}; left on ${JSON.stringify(restingOn)}`);

    // THE HOST DEALS ON FIRST (#283). A round that just ended is held on every
    // guest's felt under the score sheet until the host's own sheet closes, so
    // until then a guest is RIGHTLY showing the hand as it ended rather than
    // the next one — and "whose turn is it" has two honest answers.
    // The sheet opens a beat after the last card lands, so it is waited for.
    const sheet = await waitFor(() => overlayUp(frames.H, 'round-overlay'), 15000);
    check("host: the round's score sheet opens", sheet);
    await frames.H.evaluate(() => document.getElementById('round-continue').click());

    // A joiner that fell behind would be holding a stale view, and the only
    // honest check of that is against the host's own numbers.
    for (const label of ['A', 'B']) {
      const snap = await party(frames[label], 'partySnapshot');
      check(`joiner ${label}: kept up with the table`, snap.seq > 0, `seq ${snap.seq}`);
      check(`joiner ${label}: nothing went wrong on the way`, !snap.notice, snap.notice);
    }
    const converged = await waitFor(async () => {
      const turn = (await hostState(frames.H))?.turn;
      const seen = await frames.A.evaluate(async () => {
        const table = await window.__mod('src/ui/table.js');
        return table.tableContext()?.state?.turn?.seat ?? null;
      });
      return seen === turn;
    }, 10000);
    check('joiner A agrees with the host about whose turn it is', converged);
  },
};

/* ------------------------------------------------------------------ *
 * 2. Privacy, on the wire
 * ------------------------------------------------------------------ */

const privacy = {
  title: 'each joiner receives only its own hand; proposals never reach a fellow joiner',
  async run({ check, frames }) {
    // Record what B is HANDED, not what B renders. A filter that grades its own
    // output passes for exactly as long as the bug is consistent.
    await frames.B.evaluate(() => {
      window.__wire = [];
      // Counted as it arrives rather than read off __wire, which is cleared
      // every step: a joiner→joiner proposal is a containment failure whenever
      // it happens, not only in the step somebody happened to be looking.
      window.__seenPropose = 0;
      window.Arcade.peer.onMessage((payload) => {
        if (payload && payload.k === 'propose') window.__seenPropose++;
        window.__wire.push(JSON.stringify(payload));
      });
    });

    const first = await viewCards(frames.A);
    check('joiner A holds a view of its own', !!first && first.seat === 1, JSON.stringify(first?.seat));
    check('joiner A can see its own hand',
      (first?.zones[`hand.${first.seat}`] || []).length > 0,
      `${(first?.zones[`hand.${first.seat}`] || []).length} cards`);

    // MOVE BY MOVE, because "is this card private" is a question with a
    // different answer every move and a whole-window comparison cannot ask it.
    // A card A plays becomes the face-up discard, at which point B is ENTITLED
    // to it; a recycle can deal that same public card back into a hand. So each
    // step pairs the hand A held AT THAT MOMENT with the frames B was handed in
    // that same moment, and nothing is compared across the boundary.
    const leaked = [];
    let observed = 0;
    let watched = 0;
    for (let step = 0; step < 14; step++) {
      const before = await viewCards(frames.A);
      const hand = before?.zones[`hand.${before?.seat}`] || [];
      await frames.B.evaluate(() => { window.__wire.length = 0; });

      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* not our turn */ }
      }
      await new Promise((r) => setTimeout(r, 60));

      const wire = await frames.B.evaluate(() => window.__wire.slice());
      if (!wire.length) continue;
      observed += wire.length;

      // BOTH ENDS OF THE STEP, and that is what makes the comparison exact.
      // The card A plays during a step is in the hand this step opened with and
      // is the face-up discard by the time B's view is built — B is entitled to
      // it, and grading against the opening snapshot alone would call that a
      // leak every single hand. A card still in A's hand when the step CLOSES
      // was private for the whole step, so those are the ids that can prove
      // something, and B must not have been handed one.
      const after = await viewCards(frames.A);
      const still = new Set(after?.zones[`hand.${after?.seat}`] || []);
      const private_ = hand.filter((id) => still.has(id));
      if (!private_.length) continue;
      watched++;
      for (const id of private_) {
        if (wire.some((frame) => frame.includes(`"${id}"`))) leaked.push(`${id} @${step}`);
      }
    }

    check('joiner B was never handed a card that was in joiner A\'s hand at the time',
      leaked.length === 0 && watched > 0,
      leaked.length ? leaked.slice(0, 3).join(', ')
        : `${watched} steps with cards in hand, ${observed} frames to B`);

    const proposals = await frames.B.evaluate(() => window.__seenPropose || 0);
    check('joiner B never saw another joiner\'s proposal', proposals === 0,
      `${proposals} propose frames reached B`);

    const b = await viewCards(frames.B);
    const foreign = Object.keys(b?.zones || {})
      .filter((address) => /^hand\.\d+$/.test(address) && address !== `hand.${b.seat}`);
    check('joiner B\'s view carries no card list for anybody else\'s hand',
      foreign.length === 0, foreign.join(', '));
  },
};

/* ------------------------------------------------------------------ *
 * 3. The error path
 * ------------------------------------------------------------------ */

const unknownTarget = {
  title: 'a refused targeted send surfaces, rather than quietly broadcasting',
  async run({ check, frames }) {
    // WHAT THE REAL SDK ACTUALLY DOES, recorded rather than assumed. `send`
    // is not a delivery receipt and never was; what it answers is whether the
    // transport would ACCEPT the frame. It does not check the target against
    // the roster, so an unknown deviceId comes back true and the frame is
    // simply dropped downstream. The `false` the game handles is a real answer
    // for a real reason — no live connection, or the `peer.sendTo` capability
    // missing — and this is the honest record of which is which.
    // THE FRAME IS BUILT, NOT TYPED. This was the one `{ k: 'bye', ... }` in
    // the repo that never named `FRAME` at all, so a renamed kind would have
    // left this scenario cheerfully sending a frame nothing on the far end
    // recognises — and passing, because what it measures is the transport's
    // answer rather than the far end's.
    const unknown = await frames.H.evaluate(async () => {
      const { byeFrame } = await window.__mod('src/match/frames.js');
      return window.Arcade.peer.send(
        { ...byeFrame('leave'), tableId: 'tbl-unreachable' }, { to: 'no-such-device' });
    });
    check('an unknown target is accepted by the transport, not refused',
      unknown === true,
      `send(to: unknown) → ${unknown}. If this ever returns false, the launcher `
      + 'gained target validation and the seat-unreachable path gets a second trigger.');

    // The path the game owns: when `send` DOES answer false, the refusal is
    // surfaced and never turned into a broadcast. A private frame that fails
    // over to everybody is the one failure this design cannot have.
    const surfaced = await frames.H.evaluate(async () => {
      const { createTableHost } = await window.__mod('src/match/host.js');
      const { tableRules } = await window.__mod('src/engine/tableRules.js');
      const table = await window.__mod('src/ui/table.js');
      // A REAL STATE, because a view is what gets sent and a view needs a pack.
      // Only the peer and the seat ownership are stand-ins, and they are the
      // two things the scenario is about.
      const live = table.tableContext();
      const seen = [];
      const sent = [];
      const host = createTableHost({
        rules: tableRules,
        tableId: 'tbl-unreachable',
        peer: {
          self: () => ({ deviceId: 'host' }),
          peers: () => [],
          send: (payload, opts) => { sent.push(opts?.to ?? '*'); return false; },
          onMessage: () => () => {}, onReady: () => () => {},
          onPeersChange: () => () => {}, onStatus: () => () => {},
        },
        seats: {
          count: 1,
          ownerOf: () => ({ kind: 'device', deviceId: 'no-such-device', localIndex: 0 }),
          seatsOfDevice: () => [0],
        },
        liveState: () => live.state,
        packInfo: () => ({ packId: live.pack.id, variants: live.pack.activeVariants ?? [] }),
        hooks: { onError: (e) => seen.push(e.kind) },
      });
      host.fanOut([]);
      return { seen, sent };
    });
    check('a refused targeted send is reported', surfaced.seen.includes('send-failed'),
      surfaced.seen.join(','));
    check('and is never re-sent as a broadcast',
      surfaced.sent.length > 0 && !surfaced.sent.includes('*'), surfaced.sent.join(','));

    // And the seat it was aimed at is the one the player is told about.
    const marked = await frames.H.evaluate(async () => {
      const p = await window.__mod('src/ui/party.js');
      return p.partySnapshot().unreachable;
    });
    check('the live table has no unreachable seats while every link is up',
      marked.length === 0, marked.join(','));
  },
};

/* ------------------------------------------------------------------ *
 * 4 & 5. The two that need to reach inside the transport
 * ------------------------------------------------------------------ */

const interruption = {
  title: 'a joiner drops mid-hand: seat interrupted, table plays on, queued frames arrive once',
  async run({ frames, check }) {
    skip('mid-hand network kill',
      'cutting a live RTCDataChannel needs a transport-level hook the SDK and '
      + 'startP2PHarness do not expose; covered headlessly in tests/protocol.test.js');
    // What CAN be checked here is the half that is ours: an interrupted seat is
    // a chip, never a decision, and the host asks about `gone` alone.
    const statuses = (await party(frames.H, 'partySnapshot')).seats;
    check('every seated device reads as connected while the links are up',
      statuses.filter((s) => s.status === 'gone').length === 0,
      JSON.stringify(statuses));
  },
};

const overflow = {
  title: 'a replay queue that overflowed recovers by snapshot',
  async run() {
    skip('forced replay-queue overflow',
      "`peer.queue().overflowed` is the transport's own flag with no test setter; "
      + 'the snapshot recovery it triggers is covered in tests/protocol.test.js');
  },
};

/* ------------------------------------------------------------------ *
 * 6. An older launcher
 * ------------------------------------------------------------------ */

const capsStripped = {
  title: 'a launcher without the required capabilities gets one specific notice',
  async run({ check, frames }) {
    // The gate is a pure function of what `Arcade.peer.caps()` answers, so the
    // honest way to test it is to ask it about an older launcher rather than to
    // break this one — which would also break every scenario after it.
    const verdicts = await frames.A.evaluate(async () => {
      const { peerAvailability, REQUIRED_CAPS } = await window.__mod('src/match/peerPort.js');
      const withCaps = (caps) => peerAvailability({
        status: () => 'connected', caps: () => caps,
        self: () => ({}), peers: () => [], send: () => true,
        onMessage: () => {}, onReady: () => {}, onPeersChange: () => {}, onStatus: () => {},
      });
      return {
        live: peerAvailability(),
        old: withCaps(['peer.sendTo']),
        none: peerAvailability({}),
        required: REQUIRED_CAPS,
      };
    });
    check('this launcher passes the gate', verdicts.live.available === true);
    check('a launcher missing capabilities is named, so the notice can be specific',
      verdicts.old.available === false
      && verdicts.old.reason === 'launcher-too-old'
      && verdicts.old.missing.join(',') === 'peer.roster,peer.meta',
      JSON.stringify(verdicts.old));
    check('no peer surface at all is standalone, not a broken launcher',
      verdicts.none.available === false && verdicts.none.reason === 'no-peer-api',
      JSON.stringify(verdicts.none));

    // And the notice itself: the door says what is wrong rather than vanishing.
    // THE DOOR IS THE GAME TILE'S "Play together" (#286) — the header button
    // is only ever the "update required" notice now.
    const label = await frames.A.evaluate(async () => {
      const door = document.querySelector('.tile__together');
      return { text: door?.textContent, hidden: !door || door.hidden };
    });
    check('the multiplayer door is open on a launcher that qualifies',
      label.hidden === false, JSON.stringify(label));
  },
};

/* ------------------------------------------------------------------ *
 * 7. Peer names, and the chips that describe them
 * ------------------------------------------------------------------ */

const HOSTILE = '<img src=x onerror="window.__pwned = 1">';

const namesAndChips = {
  title: 'a hostile peer name renders inert; chips follow scripted status transitions',
  async run({ check, frames }) {
    // Rewrite what the ROSTER says the peers are called. This is the real
    // shape: a name is a string another device chose, and `peerName()` is the
    // one door it comes through on its way to the seat grid.
    const result = await frames.H.evaluate(async ({ hostile }) => {
      const p = await window.__mod('src/ui/party.js');
      // #78: a WORSE reading has to hold before the screen repeats it, so every
      // downgrade below is read twice — once at once, and once after probation.
      const { SETTLE_MS } = await window.__mod('src/ui/partyModel.js');
      const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS + 750));
      const real = window.Arcade.peer.peers;
      const patch = (mutate) => { window.Arcade.peer.peers = () => mutate(real.call(window.Arcade.peer)); };
      const chipsNow = () => [...document.querySelectorAll('.party-seat')].map((row) => ({
        seat: Number(row.dataset.seat),
        chip: [...row.querySelectorAll('.presence-chip')].map((c) => c.className).join(' '),
      }));

      patch((peers) => peers.map((peer) => ({ ...peer, name: hostile })));
      p.showPartyScreen();
      const grid = document.getElementById('party-seats');
      const rendered = {
        html: grid.innerHTML,
        text: [...grid.querySelectorAll('.party-seat__name')].map((n) => n.textContent),
        images: grid.querySelectorAll('img').length,
        pwned: !!window.__pwned,
      };

      // Scripted transitions, one status at a time.
      patch((peers) => peers.map((peer) => ({ ...peer, status: 'interrupted' })));
      p.showPartyScreen();
      const blip = chipsNow();   // straight away: still connected (#78)
      // NOTHING REPAINTS HERE ON PURPOSE. The screen arms one timer for the
      // moment probation ends, so reading after the wait with no repaint of our
      // own is what proves that timer exists and fires.
      await settle();
      const interrupted = chipsNow();

      patch(() => []);           // every peer off the roster: terminal drop
      p.refreshEntry();          // the same re-ask returning to this screen does
      p.showPartyScreen();
      const stillHere = chipsNow();
      await settle();
      const gone = chipsNow();
      const decision = !document.getElementById('party-decision').hidden;

      window.Arcade.peer.peers = real;
      p.showPartyScreen();
      return { rendered, blip, interrupted, stillHere, gone, decision, restored: chipsNow() };
    }, { hostile: HOSTILE });

    check('a hostile peer name reaches the DOM as text, never as markup',
      result.rendered.images === 0 && !result.rendered.pwned
      && !result.rendered.html.includes('<img'),
      result.rendered.html.slice(0, 120));
    check('and it is still the name the peer chose, verbatim',
      result.rendered.text.includes(HOSTILE), JSON.stringify(result.rendered.text));

    // #78, IN THE REAL THING. The unit tests walk `partyModel` forward by
    // handing it different `now`s; only here does a real clock, a real repaint
    // and the one-shot timer that drives it all take part.
    check('a link that has only just dropped shows nothing yet — a blip is not news',
      result.blip.every((row) => !row.chip.includes('--interrupted')),
      JSON.stringify(result.blip));
    check('an interrupted link shows a reconnecting chip once it has held',
      result.interrupted.some((row) => row.chip.includes('presence-chip--interrupted')),
      JSON.stringify(result.interrupted));
    check('a peer that has only just left the roster is not called gone yet',
      result.stillHere.every((row) => !row.chip.includes('--gone')),
      JSON.stringify(result.stillHere));
    check('a peer off the roster reads as gone once it has held',
      result.gone.some((row) => row.chip.includes('presence-chip--gone')),
      JSON.stringify(result.gone));
    check("and only 'gone' asks the host for a decision", result.decision === true);
    check('the chips follow the roster back to connected',
      result.restored.every((row) => !row.chip.includes('--gone')),
      JSON.stringify(result.restored));

    await frames.H.evaluate(() => { document.getElementById('party-decision').hidden = true; });
  },
};

/* ------------------------------------------------------------------ *
 * 8. Leaving, and coming back
 * ------------------------------------------------------------------ */

const rejoining = {
  title: 'a player who leaves can come back, and so can one whose host did',
  async run({ check, waitFor, frames }) {
    // A. THE JOINER LEAVES UNDER ITS OWN POWER and comes back to the same table.
    await party(frames.A, 'leaveTable');
    check('joiner A: leaving makes it idle', (await party(frames.A, 'partyRole')) === 'idle');

    await party(frames.A, 'refreshEntry');
    const backAsClient = await waitFor(async () => (await party(frames.A, 'partyRole')) === 'joiner', 15000);
    check('joiner A: the table it just left is still an invitation', backAsClient,
      `role ${await party(frames.A, 'partyRole')}`);

    await frames.A.evaluate(async () => (await window.__mod('src/ui/party.js')).showPartyScreen());
    // BACK IN ITS CHAIR, OR OFFERED ONE. The host keeps a departed player's
    // chair bound to them (src/match/host.js `seatStatus`), so the roster can
    // already have A sitting in it again — and a guest who is sitting is
    // offered no second chair (one each, #285).
    const offered = await waitFor(async () => (await party(frames.A, 'partySnapshot')).seat !== null
      || await frames.A.evaluate(() => document.querySelectorAll('.party-seat__actions button').length > 0), 15000);
    check('joiner A: is back in its seat, or offered one to come back to', offered,
      await frames.A.evaluate(() => document.querySelector('#party-seats')?.textContent?.trim()?.slice(0, 120)));
    check('joiner A: and is not still being told the table closed',
      !(await party(frames.A, 'partySnapshot')).notice,
      (await party(frames.A, 'partySnapshot')).notice);

    // B. THE HOST LEAVES AND COMES BACK, which ends the table for everybody —
    //    and the people it ended it for must be able to sit down at the next one.
    await party(frames.H, 'stopHosting');
    await party(frames.H, 'hostGame', PACK);
    check('host: can open a fresh table after closing one',
      (await party(frames.H, 'partyRole')) === 'host');

    for (const label of ['A', 'B']) {
      const invited = await waitFor(async () => {
        await party(frames[label], 'refreshEntry');
        return (await party(frames[label], 'partyRole')) === 'joiner';
      }, 20000);
      check(`joiner ${label}: sees the host's new table`, invited,
        `role ${await party(frames[label], 'partyRole')}`);

      await frames[label].evaluate(async () => (await window.__mod('src/ui/party.js')).showPartyScreen());
      const seats = await frames[label].evaluate(
        () => document.querySelectorAll('.party-seat__actions button').length);
      check(`joiner ${label}: is offered a seat at it`, seats > 0, `${seats} claimable seats`);
      const snap = await party(frames[label], 'partySnapshot');
      check(`joiner ${label}: is not still reading a notice about the old table`, !snap.notice, snap.notice);
    }

    // AND THE BUTTON HAS TO WORK, not merely exist. A seat you can see, can
    // count, and cannot sit down at is the failure this scenario was written
    // for; asserting on the affordance alone would have missed it entirely.
    for (const [label, seat] of [['A', 1], ['B', 2]]) {
      await frames[label].evaluate(
        (s) => document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`).click(), seat);
    }
    for (const [label, seat] of [['A', 1], ['B', 2]]) {
      const took = await waitFor(async () => {
        const roster = await frames.H.evaluate(async () => {
          const p = await window.__mod('src/ui/party.js');
          return p.partySnapshot().seats;
        });
        return roster.find((r) => r.seat === seat)?.status === 'connected';
      }, 20000);
      check(`joiner ${label}: sat back down at seat ${seat}, and the host agrees`, took);
    }
  },
};

/* ------------------------------------------------------------------ *
 * 9. One table per device (#284, #285)
 * ------------------------------------------------------------------ */

const oneTable = {
  title: 'a device is at one table at a time; the host sizes the table; a closed table leaves no tile behind',
  async run({ check, waitFor, frames, devices }) {
    const SECOND = 'hearts';
    const oursNow = async () => (await party(frames.H, 'partySnapshot')).tables
      .filter((t) => t.hostDeviceId === devices.H);

    const before = await oursNow();
    check('host: starts out at exactly one table of its own', before.length === 1,
      JSON.stringify(before.map((t) => t.packId)));
    const first = before[0];

    // 1. ASKED, AND "NO" MEANS NO. The 2026-10-03 playtest hosted two tables
    //    without a word; now the second asks about the first.
    const kept = await hostGameAnswering(frames.H, SECOND, false);
    check('host: hosting a second game asks to close the first',
      /Close your .+ table\? .*hosting Hearts closes this one/.test(kept.asked || ''), kept.asked);
    check('host: and keeping it keeps it — still one table, the same one',
      kept.result === false && (await oursNow()).map((t) => t.key).join() === first.key);

    // 2. "YES" CLOSES IT, FOR EVERYBODY, AND OPENS THE NEW ONE.
    const moved = await hostGameAnswering(frames.H, SECOND, true);
    const after = await oursNow();
    check('host: closing the first opens the second — one table, now Hearts',
      moved.result === true && after.length === 1 && after[0].packId === SECOND,
      JSON.stringify(after.map((t) => t.packId)));
    const second = after[0];
    for (const label of ['A', 'B']) {
      const gone = await waitFor(async () => {
        await party(frames[label], 'refreshEntry');
        const snap = await party(frames[label], 'partySnapshot');
        return snap.tables.every((t) => t.key !== first.key);
      }, 20000);
      check(`guest ${label}: the closed table's tile is gone, not left behind`, gone);
    }

    // 3. A GUEST SITS, THEN THE HOST SIZES THE TABLE (#284).
    const sighted = await waitFor(async () => {
      await party(frames.A, 'refreshEntry');
      return (await party(frames.A, 'partySnapshot')).tables.some((t) => t.key === second.key);
    }, 20000);
    check('guest A: sees the new table', sighted);
    await party(frames.A, 'showPartyScreen', second.key);
    const offered = await waitFor(() => frames.A.evaluate(
      () => !!document.querySelector('.party-seat[data-seat="1"] .party-seat__actions button')), 20000);
    check('guest A: is offered seat 1', offered);
    await frames.A.evaluate(() => document.querySelector('.party-seat[data-seat="1"] .party-seat__actions button').click());
    await answerIfAsked(frames.A, true);
    const seatedA = await waitFor(async () => (await party(frames.A, 'partySnapshot')).seat === 1, 20000);
    check('guest A: sits down', seatedA);

    await party(frames.H, 'showPartyScreen', second.key);
    const seatsOn = async (label) => {
      await party(frames[label], 'showPartyScreen', second.key);
      return (await party(frames[label], 'partySnapshot')).seats.length;
    };
    check('host: Hearts starts at four chairs', (await seatsOn('H')) === 4);
    await frames.H.evaluate(() => document.querySelector('[data-seats="less"]').click());
    const three = await waitFor(async () => (await seatsOn('A')) === 3, 15000);
    check('host: one fewer chair — and the guest sees three', three && (await seatsOn('H')) === 3);
    check('guest A: keeps its own chair through it', (await party(frames.A, 'partySnapshot')).seat === 1);
    await frames.H.evaluate(() => document.querySelector('[data-seats="more"]').click());
    const four = await waitFor(async () => (await seatsOn('A')) === 4, 15000);
    check('host: and one more brings it back to four', four);
    const ceiling = await frames.H.evaluate(() => {
      const more = document.querySelector('[data-seats="more"]');
      return !!more && (Number(document.querySelector('.stepper__value').textContent) < 6 || more.disabled);
    });
    check("host: the stepper stops at the game's own limits", ceiling);

    // 4. A GUEST TRYING TO HOST IS ASKED TO LEAVE FIRST — and can stay.
    const stayed = await hostGameAnswering(frames.A, 'crazy-eights', false);
    check('guest A: hosting while seated asks to leave the table first',
      /Leave .+ table\? .*hosting Crazy Eights gives up your seat/.test(stayed.asked || ''), stayed.asked);
    check('guest A: and staying keeps the seat', (await party(frames.A, 'partySnapshot')).seat === 1);

    // 5. A TILE FOR A TABLE THAT CLOSED WHILE WE WERE AWAY. A seat note naming
    //    the host — who is right here, advertising a different table — clears
    //    itself; one naming a host who never comes back can be forgotten.
    const stale = 'tstaleclosedtable01';
    const lost = 'tstalelosthost00001';
    await frames.B.evaluate(([host, closed, gone]) => {
      const now = Date.now();
      const stub = (tableId, hostDeviceId) => ({
        tableId, hostDeviceId, packId: 'crazy-eights', seat: 1, hostName: 'Old host', savedAt: now, lastSeenAt: now,
      });
      window.Arcade.state.set('mpSeats', [stub(closed, host), stub(gone, 'dev-never-coming-back')]);
    }, [devices.H, stale, lost]);
    await party(frames.B, 'hidePartyScreen');
    await party(frames.B, 'refreshEntry');
    const tiles = () => frames.B.evaluate(() =>
      [...document.querySelectorAll('#tables-grid .table-tile')].map((t) => t.dataset.tableKey));
    const both = await waitFor(async () => {
      const keys = await tiles();
      return keys.includes(stale) && keys.includes(lost);
    }, 10000);
    check('guest B: two offline tiles, each with a way to let go of it', both
      && await frames.B.evaluate(() => document.querySelectorAll('.table-tile--dormant .table-tile__forget').length >= 2));
    const swept = await waitFor(async () => {
      await party(frames.B, 'refreshEntry');
      return !(await tiles()).includes(stale);
    }, 30000);
    check("guest B: the tile for a table its host closed clears itself once the host is back", swept);
    await frames.B.evaluate((key) => document
      .querySelector(`.table-tile[data-table-key="${key}"] .table-tile__forget`).click(), lost);
    const forgotten = await waitFor(async () => !(await tiles()).includes(lost), 5000);
    check('guest B: Forget clears the other', forgotten);
  },
};

/* ------------------------------------------------------------------ *
 * 10. The field test this whole redesign came from
 * ------------------------------------------------------------------ */

/**
 * THE SHAPE THAT WAS BROKEN, PLAYED THROUGH FROM A COLD START.
 *
 * The 2026-08-16 field test put three phones in a room: one host, paired with
 * two people who had never paired with EACH OTHER. Under the party model the
 * host's table was visible to one of them and invisible to the other, because a
 * member's lobby broadcast reached a fellow member only by transport relay —
 * and cardstock refuses a relayed frame as spoofed (src/ui/tableSightings.js).
 * Discovery was asymmetric by transport accident, and no amount of tapping
 * fixed it.
 *
 * So this is that room, and it starts where that room started: every scope
 * closed, three devices connected and nothing open between them. The host taps
 * "Play together", which is now a door that PROPOSES (WP6b) rather than one
 * that assumes; both joiners accept; both sight the table over their own direct
 * link; both sit down; and one move reaches both of them.
 *
 * The joiners never become adjacent, and the scenario asserts that they do not
 * — that is the point. Seating never required players to be adjacent to each
 * other, only to the host (D2), and the old model's failure was never about
 * what the physics allowed.
 */
const theFieldTestShape = {
  title: 'a host and two joiners who are strangers to each other: both sit, and one move reaches both',
  async run({ check, waitFor, pages, frames, devices }) {
    const THIRD = 'wildfire';   // a pack no earlier scenario has touched
    const SEAT = { A: 1, B: 2 };

    /** What this game can see of the world: its status and its roster. */
    const world = (frame) => frame.evaluate(() => ({
      status: window.Arcade.peer.status(),
      peers: window.Arcade.peer.peers().map((p) => p.deviceId),
    }));
    /** What the LAUNCHER can see: the durable connections underneath. */
    const links = (page) => page.evaluate(() =>
      window.__arcade.p2p.connectedPeers().map((p) => p.deviceId).sort());

    // 1. THE TOPOLOGY, ASSERTED RATHER THAN ASSUMED. Everything below means
    //    nothing if these three devices are quietly a fully-connected mesh.
    const [hostLinks, aLinks, bLinks] = [
      await links(pages.H), await links(pages.A), await links(pages.B)];
    check('the host holds both connections; the joiners hold only the host, and have never met',
      hostLinks.length === 2 && hostLinks.includes(devices.A) && hostLinks.includes(devices.B)
      && aLinks.join() === devices.H && bLinks.join() === devices.H,
      `H:[${hostLinks}] A:[${aLinks}] B:[${bLinks}]`);

    // 2. BACK TO A COLD START. Closing the scopes leaves the connections
    //    untouched — only Hang Up moves pairing state (D5) — so what is left is
    //    exactly the field test's opening position.
    for (const label of ['H', 'A', 'B']) {
      await pages[label].evaluate((g) => window.__arcade.p2p.leaveGame(g), GAME);
    }
    const cold = await waitFor(async () => {
      for (const label of ['H', 'A', 'B']) {
        const seen = await world(frames[label]);
        if (seen.status !== 'idle' || seen.peers.length) return false;
      }
      return true;
    }, 20000);
    check('every scope closed: three connected devices with no game between them', cold,
      JSON.stringify(await world(frames.H)));

    // 3. THE HOST'S DOOR. `hostGame` is what the "Play together" button on a
    //    lobby tile calls, and the proposal it sends is cardstock's own —
    //    `Arcade.peer.invite()`, unaddressed, because with no scope open this
    //    game knows no deviceId to aim at.
    for (const label of ['A', 'B']) {
      await pages[label].evaluate(() => { if (window.__invites) window.__invites.length = 0; });
    }
    // The host is at a table from scenario 9 — one table per device (#285), so
    // it is asked to close that one first, and says yes.
    const { result: hosted } = await hostGameAnswering(frames.H, THIRD, true);
    check('host: "Play together" opens a table on a pack nobody was playing', hosted === true,
      `hostGame → ${hosted}`);

    for (const label of ['A', 'B']) {
      const heard = await pages[label].waitForFunction(([dev, g]) =>
        (window.__invites || []).some((i) => i.deviceId === dev && i.gameId === g),
        [devices.H, GAME], { timeout: 20000 }).then(() => true).catch(() => false);
      check(`joiner ${label}: the host's door proposed the game to it, over its own link`, heard);
      // The yes. See tools/mp-acceptance.mjs for why the prompt itself is not
      // clicked: it is the launcher's, and its dialog chain is shared.
      await pages[label].evaluate(([dev, g]) => window.__arcade.p2p.acceptGameInvite(dev, g),
        [devices.H, GAME]);
    }

    // 4. WHAT EACH DEVICE CAN NOW SEE. A scope is per-connection, so accepting
    //    reveals a joiner to the HOST and to nobody else — the roster proves
    //    the two joiners are still strangers while both are playing.
    for (const label of ['A', 'B']) {
      const onlyTheHost = await waitFor(async () => {
        const seen = await world(frames[label]);
        return seen.peers.length === 1 && seen.peers[0] === devices.H;
      }, 20000);
      check(`joiner ${label}: the game is open with the host, and with nobody else`, onlyTheHost,
        JSON.stringify(await world(frames[label])));
    }
    const bothLinks = await waitFor(async () => (await world(frames.H)).peers.length === 2, 20000);
    check('host: the game is open on both links at once', bothLinks,
      JSON.stringify(await world(frames.H)));

    // 5. THE TABLE BECOMES VISIBLE TO BOTH — the half the field test lost. The
    //    host's lobby frame rides each direct link on `onReady`, which the
    //    accept fires, so neither joiner needs the other to hear it.
    const table = (await party(frames.H, 'partySnapshot')).tables.find((t) => t.packId === THIRD);
    check('host: the new table is in its own directory, under its own id', !!table,
      JSON.stringify(table));

    for (const label of ['A', 'B']) {
      const sighted = await waitFor(async () => {
        await party(frames[label], 'refreshEntry');
        return (await party(frames[label], 'partySnapshot')).tables.some((t) => t.key === table.key);
      }, 20000);
      check(`joiner ${label}: sights the host's table`, sighted);

      await party(frames[label], 'showPartyScreen', table.key);
      const offered = await waitFor(() => frames[label].evaluate(
        (s) => !!document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`),
        SEAT[label]), 20000);
      check(`joiner ${label}: the seat grid offers seat ${SEAT[label]}`, offered);
      await frames[label].evaluate(
        (s) => document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`).click(),
        SEAT[label]);
      // Sitting here is leaving the last table, if the host's close missed us.
      const asked = await answerIfAsked(frames[label], true);
      if (asked) console.log(`    (${label} was asked: ${asked})`);
    }

    const bothSeated = await waitFor(async () => {
      await party(frames.H, 'showPartyScreen', table.key);
      const seats = (await party(frames.H, 'partySnapshot')).seats;
      return [SEAT.A, SEAT.B].every((s) => seats.find((r) => r.seat === s)?.status === 'connected');
    }, 20000);
    check('host: both strangers are seated at one table', bothSeated,
      JSON.stringify((await party(frames.H, 'partySnapshot')).seats)
      + ` — B: ${JSON.stringify(await frames.B.evaluate(async () => {
        const p = await window.__mod('src/ui/party.js');
        const snap = p.partySnapshot();
        return { role: snap.role, seat: snap.seat, notice: snap.notice, tables: snap.tables.map((t) => [t.packId, t.key.slice(0, 5)]) };
      }))}`);

    // 6. AND THE CARDS COME OUT ONCE, TO EVERYBODY.
    await party(frames.H, 'showPartyScreen', table.key);
    await frames.H.evaluate(async () => {
      const p = await window.__mod('src/ui/party.js');
      await p.dealParty();
    });
    const seqOf = async (label) => {
      await party(frames[label], 'showPartyScreen', table.key);
      return (await party(frames[label], 'partySnapshot')).seq;
    };
    for (const label of ['A', 'B']) {
      const dealt = await waitFor(async () => (await seqOf(label)) >= 1, 20000);
      check(`joiner ${label}: the deal arrives as a view of its own seat`, dealt,
        `seq ${await seqOf(label)}`);
    }

    // THE ASSERTION THIS SCENARIO EXISTS FOR. One move, published by the host
    // down two separate direct links, landing on two devices that cannot hear
    // each other. Every player is asked each pass; only the seat whose turn it
    // is has anything to do, and the house's own seat moves on the bot's think
    // time (see scenario 1 on why patience here is load-bearing).
    const before = { A: await seqOf('A'), B: await seqOf('B') };
    let reachedBoth = false;
    for (let i = 0; i < 120 && !reachedBoth; i++) {
      await party(frames.H, 'showPartyScreen', table.key);
      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* not our turn */ }
      }
      reachedBoth = (await seqOf('A')) > before.A && (await seqOf('B')) > before.B;
      if (!reachedBoth) await new Promise((r) => setTimeout(r, 100));
    }
    check('a move reaches BOTH joiners — the thing the party model got wrong', reachedBoth,
      `A ${before.A} → ${await seqOf('A')}, B ${before.B} → ${await seqOf('B')}`);
  },
};

/* ------------------------------------------------------------------ *
 * 11. The guests keep the host's time (#283)
 * ------------------------------------------------------------------ */

/** Is this overlay on screen in this frame? */
function overlayUp(frame, id) {
  return frame.evaluate((i) => !document.getElementById(i).hidden, id);
}

const sharedBeats = {
  title: "a guest sees the completed trick, and the score sheet for as long as the host's is up",
  async run(ctx) {
    const { check, waitFor, frames } = ctx;
    // A TRICK GAME, because a trick is the beat the 2026-10-03 playtest lost —
    // and one no earlier scenario has touched, seated the way scenario 10 seats
    // strangers: by the table's own key, since this device already hosts others.
    const PACK11 = 'team-spades';
    const { result: hosted } = await hostGameAnswering(frames.H, PACK11, true);
    check(`host: opens a ${PACK11} table`, hosted === true, `hostGame → ${hosted}`);
    const table = (await party(frames.H, 'partySnapshot')).tables.find((t) => t.packId === PACK11);
    check('host: the table is in its own directory', !!table, JSON.stringify(table));
    if (!table) return;
    const SEAT = { A: 1, B: 2 };
    for (const label of ['A', 'B']) {
      const sighted = await waitFor(async () => {
        await party(frames[label], 'refreshEntry');
        return (await party(frames[label], 'partySnapshot')).tables.some((t) => t.key === table.key);
      }, 20000);
      check(`guest ${label}: sights the table`, sighted);
      await party(frames[label], 'showPartyScreen', table.key);
      const offered = await waitFor(() => frames[label].evaluate(
        (seat) => !!document.querySelector(`.party-seat[data-seat="${seat}"] .party-seat__actions button`),
        SEAT[label]), 20000);
      check(`guest ${label}: the seat grid offers seat ${SEAT[label]}`, offered);
      if (!offered) return;
      await frames[label].evaluate(
        (seat) => document.querySelector(`.party-seat[data-seat="${seat}"] .party-seat__actions button`).click(),
        SEAT[label]);
      await answerIfAsked(frames[label], true);
    }
    const seated = await waitFor(async () => {
      await party(frames.H, 'showPartyScreen', table.key);
      const seats = (await party(frames.H, 'partySnapshot')).seats;
      return [1, 2].every((seat) => seats.find((r) => r.seat === seat)?.status === 'connected');
    }, 20000);
    check('host: both guests are seated', seated);
    await party(frames.H, 'showPartyScreen', table.key);
    await frames.H.evaluate(async () => {
      const p = await window.__mod('src/ui/party.js');
      await p.dealParty();
    });

    // WHAT A'S FELT DREW, sampled in A's own page: the most cards its trick
    // zone ever held. Before #283 a guest's felt went from three cards straight
    // to an empty trick, so four was never once on its screen.
    await frames.A.evaluate(() => {
      window.__mostOnTrick = 0;
      window.__sampler = setInterval(async () => {
        const table = await window.__mod('src/ui/table.js');
        const n = table.tableContext()?.state?.view?.zones?.trick?.cards?.length ?? 0;
        window.__mostOnTrick = Math.max(window.__mostOnTrick, n);
      }, 40);
    });

    const before = await hostState(frames.H);
    let last = before.moves;
    let idle = 0;
    for (let i = 0; i < 900 && idle < 40; i++) {
      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* a frame mid-render */ }
      }
      const now = await hostState(frames.H);
      if (!now) break;
      if (now.moves === last) idle++; else { idle = 0; last = now.moves; }
      if (now.round > before.round || now.over) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const after = await hostState(frames.H);
    check('the hand played out to the end of a round', !!after && after.round > before.round,
      `${after?.moves} moves, round ${before.round} → ${after?.round}`);

    const most = await frames.A.evaluate(() => { clearInterval(window.__sampler); return window.__mostOnTrick; });
    check('guest A was shown a completed trick — all four cards on the felt', most === 4, `most seen: ${most}`);

    // THE SHEET, ON BOTH SIDES OF THE TABLE.
    const hostSheet = await waitFor(() => overlayUp(frames.H, 'round-overlay'), 20000);
    check('host: the score sheet is up', hostSheet);
    for (const label of ['A', 'B']) {
      const up = await waitFor(() => overlayUp(frames[label], 'round-overlay'), 20000);
      check(`guest ${label}: the score sheet is up too`, up);
    }
    const says = await frames.A.evaluate(() => document.getElementById('round-ready').textContent);
    check('guest A: the sheet says who deals', /deals the next hand/.test(says), says);
    await new Promise((r) => setTimeout(r, 1500));
    check('guest A: and it stays up while the host is still reading',
      await overlayUp(frames.A, 'round-overlay') && await overlayUp(frames.H, 'round-overlay'));

    // A's tick reaches the host's sheet.
    await frames.A.evaluate(() => document.getElementById('round-continue').click());
    const ticked = await waitFor(() => frames.H.evaluate(
      () => /ready/.test(document.getElementById('round-ready').textContent)), 10000);
    check("host: the sheet shows a guest's ready tick", ticked,
      await frames.H.evaluate(() => document.getElementById('round-ready').textContent));
    check('guest A: its button says it is ready',
      await frames.A.evaluate(() => document.getElementById('round-continue').disabled));

    // The host deals on, and the guests' sheets close with it.
    await frames.H.evaluate(() => document.getElementById('round-continue').click());
    for (const label of ['A', 'B']) {
      const down = await waitFor(async () => !(await overlayUp(frames[label], 'round-overlay')), 10000);
      check(`guest ${label}: the sheet closes when the host deals`, down);
    }
    const moving = await waitFor(async () => {
      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* not our turn */ }
      }
      return (await hostState(frames.H)).moves > after.moves;
    }, 20000);
    check('and play goes on in the new hand', moving);

    // PLAY NOW (#286): lobby → the Current Table tile → the table screen → the
    // game, for the host and for a guest.
    for (const label of ['H', 'A']) {
      await frames[label].evaluate(() => document.getElementById('lobby-button').click());
      const inLobby = await waitFor(() => frames[label].evaluate(
        () => document.getElementById('table-screen').hidden), 10000);
      await frames[label].evaluate(() => document.querySelector('#tables-grid .table-tile').click());
      const sheet = await waitFor(() => frames[label].evaluate(() => !document.getElementById('party-overlay').hidden
        && [...document.querySelectorAll('#party-actions button')].some((b) => b.textContent === 'Play now')), 10000);
      check(`${label}: the Current Table tile opens the table screen, offering Play now`, inLobby && sheet);
      await frames[label].evaluate(() => [...document.querySelectorAll('#party-actions button')]
        .find((b) => b.textContent === 'Play now').click());
      const back = await waitFor(() => frames[label].evaluate(() => !document.getElementById('table-screen').hidden
        && document.getElementById('party-overlay').hidden), 10000);
      check(`${label}: Play now goes back into the game`, back);
    }
  },
};

export const SCENARIOS = [
  scriptedHand, privacy, unknownTarget, interruption, overflow, capsStripped, namesAndChips,
  rejoining, oneTable, theFieldTestShape, sharedBeats,
];
