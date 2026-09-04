// What a finished match is WORTH: its numbers, its record, and the payload the
// game-over panel is built from.
//
// Extracted from src/ui/table.js because none of it touches the felt — it reads
// a log, writes a record, and hands back data. The one thing it deliberately
// does NOT do is open a panel: the record has to be written before the panel is
// built (the panel shows it), but the panel itself waits for the player to
// finish looking at the last card, and those are two different moments.
//
// THE OTHER ENDING — the player walking away — is recorded through the same
// `recordForfeit` contract from two other doors (src/ui/lobby.js's Start over,
// the table's own End match). The three must never disagree about what a loss
// is, which is why the payload here still carries `forfeit: false` explicitly.

import { serializeMatch } from '../engine/replay.js';
import { computeMatchStats, placements } from '../stats/matchStats.js';
import { recordResult, readStats, clearMatch } from '../arcade/storage.js';

/** Display-only faces from the manifest; see schema `heroCards`. */
export function heroFaces(manifest) {
  const faces = manifest?.heroCards;
  return Array.isArray(faces) ? faces.slice(0, 3) : [];
}

/**
 * @param me         the seat lens (src/players/seats.js); its seat is the one recorded
 * @param seating    () => the match's seating
 * @param art        () => the open match's card renderer
 * @param onConclude () => void, called before the record is written (the
 *                   table's cue to stop its timers)
 */
export function createMatchRecord({ me, seating, art, onConclude }) {
  /**
   * This match's numbers, replayed out of its own log (src/stats/matchStats.js).
   *
   * Never throws to the caller: a log the current rules can no longer replay is
   * a reason to show no stats, never a reason to lose the game-over panel — and
   * it is the same failure openTable() already handles by starting fresh.
   */
  function safeStats(state) {
    try {
      return computeMatchStats(state.pack, serializeMatch(state));
    } catch (err) {
      console.warn('[cardstock] could not compute match stats', err);
      return null;
    }
  }

  /** The per-opponent outcomes this match contributes to the head-to-head record. */
  function opponentOutcomes(state, stats) {
    const rank = stats
      ? placements(state.pack, { totals: stats.totals, winner: state.winner, seats: state.seats })
      : null;
    return seating()
      .filter((identity) => identity.isBot && identity.opponentKey)
      .map((identity) => ({
        key: identity.opponentKey,
        beaten: !!rank && rank[me.seat()] < rank[identity.seat],
      }));
  }

  function recordSentence(state) {
    const record = readStats(state.pack.id);
    const overall = record.played
      ? `${record.won} of ${record.played} in ${state.pack.manifest.name}`
      : '';
    const head = seating()
      .filter((identity) => identity.isBot && record.opponents[identity.opponentKey])
      .map((identity) => {
        const r = record.opponents[identity.opponentKey];
        return `${r.won}–${r.played - r.won} vs ${identity.name}`;
      })
      .join(' · ');
    const streak = record.streak > 1 ? `${record.streak} in a row` : '';
    // Lifetime, so the sentence answers "is the Hint button used" at a glance;
    // this match's own count is on its stat card.
    const hints = record.hints > 0 ? `${record.hints} hint${record.hints === 1 ? '' : 's'} taken` : '';
    return [overall, streak, head, hints].filter(Boolean).join(' — ');
  }

  /**
   * End the match in the books: record it and stop it resuming.
   *
   * This is the ENGINE deciding. The other ending — the player walking away —
   * is the lobby's, recorded through the same `recordResult` contract with
   * `forfeit: true` (src/ui/lobby.js). The two doors must never disagree about
   * what a loss is, which is why the storage payload still carries the field
   * even though the only value written here is `false`.
   *
   * BOOKKEEPING ONLY — it no longer opens the panel. The record has to be written
   * before the panel is built (the panel shows it), but the panel itself now
   * waits for the player (awaitFinalLook), and those are two different moments.
   * Returns everything showGameOver will need, so the wait does not have to hold
   * on to a live state to recompute it.
   */
  function concludeMatch(state, { hints = 0 } = {}) {
    onConclude();
    // A finished match is not something to resume into.
    clearMatch(state.pack.id);
    const stats = safeStats(state);
    recordResult(state.pack.id, {
      won: me.holds(state.winner),
      forfeit: false,
      opponents: opponentOutcomes(state, stats),
      hints,
    });
    return {
      seating: seating(),
      stats,
      // This match's hints, and whose card they belong on: the seat this
      // device holds, because that is who pressed the button.
      hints,
      hintSeat: me.seat(),
      recordText: recordSentence(state),
      heroFaces: heroFaces(state.pack.manifest),
      renderFace: (face) => art().face(face),
    };
  }

  return { safeStats, concludeMatch };
}
