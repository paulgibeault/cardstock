// THE CLIENT: a device that holds no state, only the last view it was sent.
//
// It cannot compute anything about the game and does not try. It cannot even
// tell you whether your own move is legal — the host ships that list with the
// view (design decision D3), because enumerating over a partial state is a
// soundness trap and the client's state is partial by construction.
//
// What it DOES own is scepticism about who is talking:
//
//   * THE HOST IS DISCOVERED, NEVER SELF-DECLARED. A `lobby` frame naming
//     itself the host proves nothing; the host is the roster entry with
//     `direct: true`, which is a fact the transport establishes and a payload
//     cannot claim.
//   * A HOST-ROLE FRAME MUST ARRIVE ON THE DIRECT LINK. Under a star topology
//     the hub relays between spokes, so a fellow joiner can address a `view`
//     frame at us. `meta.relayed` is what tells that apart, and it comes from
//     the transport rather than the payload.
//   * A GAP IN `seq` IS NOT SOMETHING TO REASON THROUGH. Views are whole
//     (D2), so a client that notices it missed one simply asks for a snapshot
//     rather than trying to interpolate. That is also the entire recovery path
//     after a replay-queue overflow, which is why there is no second one.
//
// A MISMATCHED BUILD DOES NOT PLAY. If the protocol version, the pack or its
// variants disagree with the lobby, the client refuses to seat itself and says
// so. There is deliberately no downgrade path: two builds that disagree about
// the rules produce a hand nobody can replay, and the fleet's service worker
// converges versions on its own.

import {
  FRAME, PROTOCOL_VERSION, validateFrame, isAuthentic, EMOTES,
} from './protocol.js';
import { VIEW_VERSION } from '../engine/view.js';

/**
 * @param peer      the peer port (Arcade.peer or a stub)
 * @param expects   () => ({ packId, packVersion, variants }) this build has loaded
 * @param host      WHICH table this is a client of, when the caller knows. See
 *                  `discoverHost` — with two hosts in one party, "the device we
 *                  hold a direct link to" is no longer a question with one
 *                  answer, and the caller is the only one who knows which of
 *                  them it meant to sit down with.
 * @param hooks     { onLobby, onView, onReject, onEmote, onIncompatible, onError, onEnd }
 */
export function createTableClient({ peer, expects, host = null, hooks = {} }) {
  const unsubscribes = [];
  let started = false;
  let hostDeviceId = host || null;
  let lobby = null;
  let view = null;
  let lastSeq = -1;
  let seatedAt = null;
  let pendingSnapshot = false;
  let nextPid = 1;

  const selfDeviceId = () => peer.self()?.deviceId || null;

  /**
   * The host is whoever we hold a DIRECT link to.
   *
   * On a joiner the party roster contains exactly the hub, so this is both the
   * whole answer and an unforgeable one. (A member's roster is direct-links
   * only — fellow joiners are reachable but never listed. That is the
   * transport's documented shape, not an accident of ours.)
   *
   * ONE DIRECT PEER IS NO LONGER THE ONLY SHAPE. A party can contain two hosts,
   * and then this device holds two direct links and "the" host is a question
   * with two answers — at which point this returned null and every frame from
   * either of them was dropped as spoofed, which is a client that silently does
   * not work rather than one that says why. So the CALLER names the table it
   * joined (`host` above) and this is the fallback for the single-table case.
   * The security property is untouched either way: authority is pinned to one
   * device id that came from the transport, never from a payload claiming to be
   * the host.
   */
  function discoverHost() {
    const direct = peer.peers().filter((p) => p.direct);
    return direct.length === 1 ? direct[0].deviceId : null;
  }

  function compatibility(frame) {
    const want = expects();
    if (frame.protocol !== PROTOCOL_VERSION) {
      return { ok: false, why: 'protocol', theirs: frame.protocol, ours: PROTOCOL_VERSION };
    }
    if (frame.packId !== want.packId) {
      return { ok: false, why: 'pack', theirs: frame.packId, ours: want.packId };
    }
    if (frame.packVersion && want.packVersion && frame.packVersion !== want.packVersion) {
      // Not pedantry: deck.json's ENTRY ORDER is part of the rule set, because
      // it becomes the array the seeded shuffle permutes. Two builds of a pack
      // that differ only cosmetically still deal different hands.
      return { ok: false, why: 'packVersion', theirs: frame.packVersion, ours: want.packVersion };
    }
    const ours = [...(want.variants || [])].sort();
    const theirs = [...(frame.variants || [])].sort();
    if (ours.join('|') !== theirs.join('|')) {
      return { ok: false, why: 'variants', theirs, ours };
    }
    return { ok: true };
  }

  function send(frame) {
    if (!hostDeviceId) return false;
    const delivered = peer.send(frame, { to: hostDeviceId });
    if (!delivered) hooks.onError?.({ kind: 'send-failed', frame: frame.k });
    return delivered;
  }

  /* ---------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------- */

  function acceptView(frame) {
    if (frame.view.v !== VIEW_VERSION) {
      hooks.onIncompatible?.({ why: 'view', theirs: frame.view.v, ours: VIEW_VERSION });
      return;
    }

    // A SNAPSHOT IS ALWAYS AUTHORITATIVE, whatever its seq — it is the answer
    // to our own request and the point of asking was that we do not trust what
    // we have. An ordinary view has to be the next one.
    const isSnapshot = frame.k === FRAME.SNAPSHOT;
    if (!isSnapshot && lastSeq >= 0 && frame.seq > lastSeq + 1) {
      requestSnapshot();
      return;
    }
    if (!isSnapshot && frame.seq <= lastSeq) return; // a replayed frame we already have

    pendingSnapshot = false;
    lastSeq = frame.seq;
    view = frame.view;
    seatedAt = frame.view.seat;
    hooks.onView?.(view, frame.events || [], { seq: frame.seq, snapshot: isSnapshot });
  }

  function acceptLobby(frame) {
    const verdict = compatibility(frame);
    if (!verdict.ok) {
      lobby = frame;
      hooks.onIncompatible?.(verdict);
      return;
    }
    lobby = frame;
    hooks.onLobby?.(frame);
    // A lobby while we hold a seat and no view means the host restarted, or we
    // reconnected into a match already in progress. Either way, ask.
    if (frame.started && !view && seatOfSelf(frame) !== null) requestSnapshot();
  }

  function seatOfSelf(frame) {
    const me = selfDeviceId();
    const mine = (frame?.seats || []).find((s) => s.kind === 'device' && s.deviceId === me);
    return mine ? mine.seat : null;
  }

  function onMessage(payload, fromDeviceId, meta) {
    if (!fromDeviceId) return;
    const verdict = validateFrame(payload);
    if (!verdict.ok) {
      hooks.onError?.({ kind: 'bad-frame', deviceId: fromDeviceId, reason: verdict.reason });
      return;
    }
    const frame = verdict.frame;

    // An emote is the one frame that legitimately comes from a fellow joiner,
    // so it is checked for authenticity as a NON-host frame and simply passed on.
    if (frame.k === FRAME.EMOTE) {
      hooks.onEmote?.({ deviceId: fromDeviceId, emote: EMOTES[frame.i] });
      return;
    }
    if (frame.k === FRAME.BYE) {
      if (fromDeviceId === hostDeviceId) hooks.onEnd?.({ why: frame.why });
      return;
    }

    if (!hostDeviceId) hostDeviceId = discoverHost();
    if (!isAuthentic(frame.k, { fromDeviceId, hostDeviceId, relayed: meta?.relayed })) {
      // Somebody who is not our host sent us a frame only a host may send. Not
      // an error to recover from — a thing to notice and drop.
      hooks.onError?.({
        kind: 'spoofed-authority', deviceId: fromDeviceId, frame: frame.k, relayed: !!meta?.relayed,
      });
      return;
    }

    switch (frame.k) {
      case FRAME.LOBBY: return acceptLobby(frame);
      case FRAME.VIEW:
      case FRAME.SNAPSHOT: return acceptView(frame);
      case FRAME.REJECT: return void hooks.onReject?.(frame);
      default:
        hooks.onError?.({ kind: 'unexpected-frame', deviceId: fromDeviceId, frame: frame.k });
    }
  }

  /* ---------------------------------------------------------------- *
   * Outbound
   * ---------------------------------------------------------------- */

  function claimSeat(seat, localIndex = 0) {
    return send({ k: FRAME.CLAIM_SEAT, seat, localIndex });
  }

  /**
   * Ask for a move. Returns the proposal id, so the caller can match a reject
   * to the gesture that caused it — the accept needs no matching, because the
   * accept is the next view.
   */
  function propose(move) {
    const pid = `p${nextPid++}`;
    send({ k: FRAME.PROPOSE, pid, move });
    return pid;
  }

  function requestSnapshot() {
    if (pendingSnapshot) return false; // one outstanding at a time
    pendingSnapshot = true;
    return send({ k: FRAME.SNAPSHOT_REQ, since: Math.max(0, lastSeq) });
  }

  function emote(index) {
    if (!Number.isInteger(index) || index < 0 || index >= EMOTES.length) return false;
    return peer.send({ k: FRAME.EMOTE, i: index });
  }

  function sendBye(why = 'leave') {
    return peer.send({ k: FRAME.BYE, why });
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  function start() {
    if (started) return;
    started = true;
    // A NAMED TABLE IS NEVER RE-DERIVED. Discovery is the fallback for a party
    // with one host in it; when the caller said which table it sat down at,
    // re-asking the roster can only do one of two harmful things — answer null
    // (two hosts, and then every frame from our own host is refused as a spoof)
    // or answer a DIFFERENT host, which would quietly move this client to a
    // table nobody chose.
    if (!host) hostDeviceId = discoverHost();
    unsubscribes.push(peer.onMessage(onMessage));
    unsubscribes.push(peer.onPeersChange(() => {
      if (host) return;
      const found = discoverHost();
      if (found && found !== hostDeviceId) {
        hostDeviceId = found;
      }
    }));
    unsubscribes.push(peer.onReady(() => {
      hostDeviceId = hostDeviceId || discoverHost();
      // NOTHING IN MEMORY IS ASSUMED TO HAVE SURVIVED. On any (re)arrival we
      // re-ask rather than resume from what we happen to be holding, and the
      // replay-queue's own overflow flag is checked here because a queue that
      // overflowed means the exactly-once guarantee no longer covers us.
      if (view || peer.queue?.().overflowed) requestSnapshot();
    }));
  }

  function stop() {
    for (const off of unsubscribes.splice(0)) {
      try { off?.(); } catch { /* one bad unsubscribe must not strand the rest */ }
    }
    started = false;
  }

  return {
    start,
    stop,
    claimSeat,
    propose,
    requestSnapshot,
    emote,
    sendBye,
    hostDeviceId: () => hostDeviceId,
    lobby: () => lobby,
    view: () => view,
    seat: () => seatedAt,
    seq: () => lastSeq,
  };
}
