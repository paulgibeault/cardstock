// The Definition-of-Done checklist for multiplayer (MULTIPLAYER_PLAN.md §11),
// one exported scenario per numbered item — plus the ones the checklist grew.
// 7 and 8 came from the hardening and rejoin work; 9 is the two-table case
// TABLES_PLAN.md §10 asked for, and is the only automated evidence that a
// device can host two packs at once.
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

/* ------------------------------------------------------------------ *
 * 1. A scripted hand, end to end
 * ------------------------------------------------------------------ */

async function seatEverybody({ check, waitFor, frames }) {
  // THE TABLE IS BUILT BEFORE IT IS DEALT. The host picks a game from a lobby
  // tile, everybody takes a chair, and the cards come out once — which is why
  // there is no bot holding a hand for a joiner to take it off.
  const hosted = await frames.H.evaluate(async (packId) => {
    const p = await window.__mod('src/ui/party.js');
    return p.hostGame(packId);
  }, PACK);
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

  // From here it is the real UI: the header button, then the seat's own claim.
  for (const label of ['A', 'B']) {
    await frames[label].evaluate(() => document.getElementById('party-button').click());
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
    const unknown = await frames.H.evaluate(() =>
      window.Arcade.peer.send({ k: 'bye', why: 'leave', tableId: 'tbl-unreachable' }, { to: 'no-such-device' }));
    check('an unknown target is accepted by the transport, not refused',
      unknown === true,
      `send(to: unknown) → ${unknown}. If this ever returns false, the launcher `
      + 'gained target validation and the seat-unreachable path gets a second trigger.');

    // The path the game owns: when `send` DOES answer false, the refusal is
    // surfaced and never turned into a broadcast. A private frame that fails
    // over to everybody is the one failure this design cannot have.
    const surfaced = await frames.H.evaluate(async () => {
      const { createTableHost } = await window.__mod('src/match/host.js');
      const table = await window.__mod('src/ui/table.js');
      // A REAL STATE, because a view is what gets sent and a view needs a pack.
      // Only the peer and the seat ownership are stand-ins, and they are the
      // two things the scenario is about.
      const live = table.tableContext();
      const seen = [];
      const sent = [];
      const host = createTableHost({
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
    const label = await frames.A.evaluate(async () => {
      const button = document.getElementById('party-button');
      return { text: button.textContent, hidden: button.hidden };
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
    const offered = await waitFor(() => frames.A.evaluate(
      () => [...document.querySelectorAll('.party-seat__actions button')].map((b) => b.textContent)), 15000)
      && await frames.A.evaluate(() => document.querySelectorAll('.party-seat__actions button').length > 0);
    check('joiner A: is offered a seat to come back to', offered,
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
 * 9. Two packs at once
 * ------------------------------------------------------------------ */

const twoPacks = {
  title: 'one device hosts two packs at once; a joiner sits at both, and no frame crosses',
  async run({ check, waitFor, frames, devices }) {
    const SECOND = 'hearts';

    // WHAT #43 ASKED FOR AND NOTHING DROVE. Everything above this is one table;
    // the model has held several since T3 and the only evidence was a browser
    // probe. This is the real transport, three launchers, two tables.
    const first = (await party(frames.H, 'partySnapshot')).tables.find((t) => t.active)
      || (await party(frames.H, 'partySnapshot')).tables[0];

    const opened = await party(frames.H, 'hostGame', SECOND);
    check('host: a second pack opens a second table', opened === true, `hostGame → ${opened}`);

    const tables = (await party(frames.H, 'partySnapshot')).tables;
    const ours = tables.filter((t) => t.hostDeviceId === devices.H);
    const packs = new Set(ours.map((t) => t.packId));
    check('host: two tables of two different packs, under two ids',
      ours.length >= 2 && packs.has(PACK) && packs.has(SECOND)
        && new Set(ours.map((t) => t.key)).size === ours.length,
      JSON.stringify(ours.map((t) => ({ pack: t.packId, key: t.key.slice(0, 6) }))));

    const second = ours.find((t) => t.packId === SECOND);
    check('host: the new table is a table nobody has dealt yet', second && !second.started,
      JSON.stringify(second));

    // A IS ALREADY SITTING AT THE FIRST ONE. Sighting the second is not joining
    // it — with a seat already held, the sniffer stops following new tables, so
    // this is the tap that #49 part 4 made possible.
    const SEAT = 3;
    const sawIt = await waitFor(async () => {
      await party(frames.A, 'refreshEntry');
      return (await party(frames.A, 'partySnapshot')).tables.some((t) => t.key === second.key);
    }, 20000);
    check('joiner A: hears the second table without being dragged off the first', sawIt);

    await party(frames.A, 'showPartyScreen', second.key);
    const offered = await waitFor(() => frames.A.evaluate(
      (s) => !!document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`), SEAT), 20000);
    check(`joiner A: the second table offers seat ${SEAT}`, offered);
    await frames.A.evaluate(
      (s) => document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`).click(), SEAT);

    // TWO SEATS, AND THE PANEL ANSWERS ABOUT WHICHEVER TABLE IT IS SHOWING.
    const seatAt = async (key) => {
      await party(frames.A, 'showPartyScreen', key);
      return (await party(frames.A, 'partySnapshot')).seat;
    };
    const bothHeld = await waitFor(async () => await seatAt(second.key) === SEAT, 20000);
    check(`joiner A: holds seat ${SEAT} at the second table`, bothHeld,
      `seat ${await seatAt(second.key)}`);
    const firstSeat = await seatAt(first.key);
    check('joiner A: and still holds its seat at the first', firstSeat !== null && firstSeat !== undefined,
      `seat ${firstSeat}`);

    // BOTH TABLES GET DEALT, because the interesting assertion needs both to
    // have a view to compare. Dealing acts on the table the panel is showing,
    // which is itself the thing being tested: `ourTable()` resolves by focus.
    const seqOf = async (key) => {
      await party(frames.A, 'showPartyScreen', key);
      return (await party(frames.A, 'partySnapshot')).seq;
    };
    const dealAt = async (key) => {
      await party(frames.H, 'showPartyScreen', key);
      await frames.H.evaluate(async () => {
        const p = await window.__mod('src/ui/party.js');
        await p.dealParty();
      });
    };

    await dealAt(first.key);
    const firstDealt = await waitFor(async () => await seqOf(first.key) >= 1, 20000);
    check('joiner A: the FIRST table deals into its own view', firstDealt,
      `seq ${await seqOf(first.key)}`);
    const firstSeqBefore = await seqOf(first.key);

    await dealAt(second.key);
    const secondDealt = await waitFor(async () => await seqOf(second.key) >= 1, 20000);
    check('joiner A: the second table deals into its own view too', secondDealt,
      `seq ${await seqOf(second.key)}`);

    // THE ASSERTION THIS SCENARIO EXISTS FOR. Both tables now have a view, so
    // "unchanged" means something: a deal that leaked would have advanced the
    // other table's sequence as well.
    check('no frame crossed: dealing one table left the other exactly where it was',
      (await seqOf(first.key)) === firstSeqBefore,
      `first ${firstSeqBefore} → ${await seqOf(first.key)}`);

    // And once more with a MOVE rather than a deal, which is the path every
    // frame after the first takes.
    const beforeMove = { first: await seqOf(first.key), second: await seqOf(second.key) };
    await party(frames.H, 'showPartyScreen', second.key);
    await party(frames.H, 'takeTurn');
    const moved = await waitFor(async () => await seqOf(second.key) > beforeMove.second, 20000);
    check('a move at one table reaches that table', moved,
      `second ${beforeMove.second} → ${await seqOf(second.key)}`);
    check('and reaches only that table',
      (await seqOf(first.key)) === beforeMove.first,
      `first ${beforeMove.first} → ${await seqOf(first.key)}`);

    check('host: is still the host of both', ours.length >= 2
      && (await party(frames.H, 'partySnapshot')).role === 'host',
      `${ours.length} table(s) of ours`);

    // THE ROW, IN THE DOM, on the device that is only a guest at both tables.
    // Everything above reads `partySnapshot()`, which reports the directory —
    // so it would go on passing if the tiles drawn FROM that directory had
    // stopped being drawn. Added with #73, which moved the sniffing and the
    // directory into src/ui/tableSightings.js: the tile row is the visible end
    // of that pipe, and it has never had an assertion on it.
    await frames.A.evaluate(() => document.getElementById('party-button').click());
    const drawnTiles = () => frames.A.evaluate(() =>
      [...document.querySelectorAll('#tables-grid .table-tile')].map((tile) => ({
        key: tile.dataset.tableKey,
        game: tile.querySelector('.table-tile__game')?.textContent || '',
        seat: !!tile.querySelector('.table-tile__seat'),
      })));
    await waitFor(async () => (await drawnTiles()).length >= 2, 20000);
    const tiles = await drawnTiles();
    check('joiner A: a tile for each table, one per game, each promising its own seat',
      tiles.length === 2
        && new Set(tiles.map((t) => t.key)).size === 2
        && new Set(tiles.map((t) => t.game)).size === 2
        && tiles.every((t) => t.seat),
      JSON.stringify(tiles));
  },
};

export const SCENARIOS = [
  scriptedHand, privacy, unknownTarget, interruption, overflow, capsStripped, namesAndChips,
  rejoining, twoPacks,
];
