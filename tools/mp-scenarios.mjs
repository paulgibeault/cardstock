// The Definition-of-Done checklist for multiplayer (MULTIPLAYER_PLAN.md §11),
// one exported scenario per numbered item.
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
  // The host opens an ordinary solo table — nothing about dealing changes for
  // a party — and then starts publishing it.
  await frames.H.evaluate(async (packId) => {
    const table = await window.__mod('src/ui/table.js');
    document.getElementById('lobby').hidden = true;
    document.getElementById('table-screen').hidden = false;
    await table.openTable(packId);
  }, PACK);
  await frames.H.waitForFunction("!!document.querySelector('#table .hand')  || !!document.getElementById('center-piles').childElementCount");

  const hosted = await party(frames.H, 'startHosting');
  check('host: publishing an ordinary table turns it into a shared one', hosted === true);
  const role = await party(frames.H, 'partyRole');
  check('host: role is host', role === 'host', role);

  // The joiners have been listening the whole time: the invitation is a lobby
  // frame, believed only from the direct link and never when relayed.
  for (const label of ['A', 'B']) {
    const sighted = await waitFor(async () => {
      await party(frames[label], 'refreshEntry');
      return frames[label].evaluate(() => document.getElementById('party-button')?.textContent === 'Join the table');
    }, 20000);
    check(`joiner ${label}: sees an invitation to the table`, sighted);
  }

  // From here on it is the real UI: the entry button, the Join action, and the
  // seat's own claim button.
  const seatOf = { A: 1, B: 2 };
  for (const label of ['A', 'B']) {
    await frames[label].evaluate(() => document.getElementById('party-button').click());
    await frames[label].waitForFunction("!!document.querySelector('#party-actions button')", null, { timeout: 10000 });
    await frames[label].evaluate(() => document.querySelector('#party-actions button').click());
    const seat = seatOf[label];
    const ready = await waitFor(() => frames[label].evaluate(
      (s) => !!document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`), seat), 20000);
    check(`joiner ${label}: the seat grid offers seat ${seat}`, ready);
    await frames[label].evaluate(
      (s) => document.querySelector(`.party-seat[data-seat="${s}"] .party-seat__actions button`).click(), seat);
  }

  for (const label of ['A', 'B']) {
    const seated = await waitFor(async () => (await party(frames[label], 'partySnapshot')).seat === seatOf[label], 20000);
    const snap = await party(frames[label], 'partySnapshot');
    check(`joiner ${label}: is seated at ${seatOf[label]} and holds a view`, seated, `seat ${snap.seat}, seq ${snap.seq}`);
    const onTable = await frames[label].evaluate(() => !document.getElementById('table-screen').hidden);
    check(`joiner ${label}: the felt is on screen`, onTable);
  }
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
    let last = before.moves;
    let idle = 0;
    for (let i = 0; i < 400 && idle < 12; i++) {
      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* a frame mid-render */ }
      }
      const now = await hostState(frames.H);
      if (!now) break;
      if (now.moves === last) idle++; else { idle = 0; last = now.moves; }
      if (now.round > before.round || now.over) break;
      await new Promise((r) => setTimeout(r, 60));
    }

    const after = await hostState(frames.H);
    check('the hand played out to the end of a round',
      !!after && (after.round > before.round || after.over),
      `${after?.moves} moves, round ${before.round} → ${after?.round}`);

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
      window.Arcade.peer.onMessage((payload) => { window.__wire.push(JSON.stringify(payload)); });
    });

    const a = await viewCards(frames.A);
    check('joiner A holds a view of its own', !!a && a.seat === 1, JSON.stringify(a?.seat));
    const handBefore = a?.zones[`hand.${a.seat}`] || [];
    check('joiner A can see its own hand', handBefore.length > 0, `${handBefore.length} cards`);

    // A move each, so there is traffic to examine.
    for (let i = 0; i < 12; i++) {
      for (const label of ['H', 'A', 'B']) {
        try { await party(frames[label], 'takeTurn'); } catch { /* not our turn */ }
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    // THE COMPARISON IS AGAINST CARDS THAT NEVER LEFT A'S HAND, and the reason
    // is a false positive that would otherwise be guaranteed: a card A plays
    // becomes the face-up discard, at which point B is ENTITLED to it — and a
    // recycle can later deal that same public card back into a hand. Only the
    // ids A held for the whole window are unambiguously private for the whole
    // window, so only those can prove anything.
    const wire = await frames.B.evaluate(() => window.__wire.slice());
    const after = await viewCards(frames.A);
    const handAfter = new Set(after?.zones[`hand.${after?.seat}`] || []);
    const held = handBefore.filter((id) => handAfter.has(id));
    const leaked = held.filter((id) => wire.some((frame) => frame.includes(`"${id}"`)));
    check('joiner B was never handed a card that stayed in joiner A\'s hand',
      leaked.length === 0 && held.length > 0,
      leaked.length ? leaked.slice(0, 3).join(', ') : `${held.length} cards held throughout`);

    const proposals = wire.filter((frame) => frame.includes('"k":"propose"'));
    check('joiner B never saw another joiner\'s proposal', proposals.length === 0,
      `${proposals.length} propose frames reached B`);

    const b = await viewCards(frames.B);
    const foreign = Object.keys(b?.zones || {}).filter((address) => /^hand\.\d+$/.test(address) && address !== `hand.${b.seat}`);
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
      window.Arcade.peer.send({ k: 'bye', why: 'leave' }, { to: 'no-such-device' }));
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
      const interrupted = chipsNow();

      patch(() => []);           // every peer off the roster: terminal drop
      p.refreshEntry();          // the same re-ask returning to this screen does
      p.showPartyScreen();
      const gone = chipsNow();
      const decision = !document.getElementById('party-decision').hidden;

      window.Arcade.peer.peers = real;
      p.showPartyScreen();
      return { rendered, interrupted, gone, decision, restored: chipsNow() };
    }, { hostile: HOSTILE });

    check('a hostile peer name reaches the DOM as text, never as markup',
      result.rendered.images === 0 && !result.rendered.pwned
      && !result.rendered.html.includes('<img'),
      result.rendered.html.slice(0, 120));
    check('and it is still the name the peer chose, verbatim',
      result.rendered.text.includes(HOSTILE), JSON.stringify(result.rendered.text));

    check('an interrupted link shows a reconnecting chip, on every seated device',
      result.interrupted.some((row) => row.chip.includes('presence-chip--interrupted')),
      JSON.stringify(result.interrupted));
    check('a peer off the roster reads as gone',
      result.gone.some((row) => row.chip.includes('presence-chip--gone')),
      JSON.stringify(result.gone));
    check("and only 'gone' asks the host for a decision", result.decision === true);
    check('the chips follow the roster back to connected',
      result.restored.every((row) => !row.chip.includes('--gone')),
      JSON.stringify(result.restored));

    await frames.H.evaluate(() => { document.getElementById('party-decision').hidden = true; });
  },
};

export const SCENARIOS = [
  scriptedHand, privacy, unknownTarget, interruption, overflow, capsStripped, namesAndChips,
];
