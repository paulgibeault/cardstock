// ONE WAY A TABLE IS WRITTEN DOWN (#225).
//
// There were two persist paths with the same policy written twice: the felt's
// `persistMatch` (src/ui/table.js) for solo and daily play, and the party's
// `persist` (src/ui/party.js) for a hosted table under `mpMatch.<tableId>`. Each
// had its own "a view is not a match" guard; the felt needed a third guard to
// keep a hosted table out of the solo slot; only the party's knew that a
// finished match is not a resumable one — and #166 (End match leaves the
// finished save behind) was what that split cost. Both callers now hand this
// the table (src/match/tableSession.js) and it decides from the table's role.
//
//   a joiner, or any view    nothing. It holds a view rather than a match: the
//                            log is the host's, and a rejoin re-asks for a
//                            snapshot rather than resuming from whatever it was
//                            holding (src/match/client.js).
//   a host                   `mpMatch.<tableId>`, with its seat bindings and its
//                            grace — never the solo slot, which is what stops
//                            two diverging copies of one shared game.
//   solo                     `match.<packId>`, or `daily.<packId>` for today's
//                            run, so a daily never overwrites the casual game
//                            waiting on the same lobby tile.
//
// A FINISHED MATCH IS NOT A RESUMABLE ONE, for every role. Finished means the
// engine ended it (`gameOver`) or the player did (`concluded`, set by
// `concludeTable`); either way its slot is cleared rather than written, so the
// flush that runs on the way out of the table cannot put it back.

import { saveMatch, clearMatch, saveHostMatch, clearHostMatch } from './storage.js';

/**
 * Write `table`'s match to the slot its role names, or clear that slot if the
 * match is over.
 *
 * @returns the storage write's result (false when a save was refused), `true`
 *   when a finished match's slot was cleared, and `null` when there was nothing
 *   of ours to write — no table, no state yet, or a view.
 */
export function persistTable(table) {
  const state = table?.state;
  if (!state) return null;
  // A VIEW IS NOT A MATCH. Asked of the state as well as the role: the state
  // knows what it is, and a joiner's table never holds anything else.
  if (state.isView || table.role === 'joiner') return null;
  const finished = !!(state.gameOver || table.concluded);

  if (table.hosting()) {
    if (!table.seats) return null;
    if (finished) { clearHostMatch(table.tableId); return true; }
    return saveHostMatch(table.tableId, state, table.seats, { graceMs: table.graceMs });
  }

  const slot = table.daily ? 'daily' : 'match';
  if (finished) { clearMatch(state.pack.id, { slot }); return true; }
  return saveMatch(state, { hints: table.hintsTaken, slot });
}

/**
 * The player ended this match. Mark it, and clear its slot now.
 *
 * The mark is the half that matters: the table is about to be closed, and
 * closing flushes — which, before #166, wrote the match straight back into the
 * slot this had just cleared, so the lobby tile offered to resume a game whose
 * forfeit had already been recorded.
 */
export function concludeTable(table) {
  if (!table) return null;
  table.concluded = true;
  return persistTable(table);
}
