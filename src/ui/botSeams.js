// THE SEAMS A BOT DRIVER IS BUILT WITH, spelled once for both of its callers.
//
// `createBotDriver` (src/ui/botDriver.js) takes everything it touches by
// injection, which is what lets it run in two places: on the felt, where a
// bot's move animates, logs and saves (src/ui/table.js), and headless, for a
// hosted table nobody is looking at, where it is published and nothing more
// (src/ui/party.js). Both sites used to spell the whole option list out, and
// most of it was the same list: the two live reads of the player's settings,
// the seat lens, the acting-seats question. Carved here in #223 seam 7 so that
// what the two drivers SHARE is one piece of code and what they do not is a
// short, named list at each call site.
//
// WHAT STILL DIFFERS, AND WHY (the arguments each caller must pass):
//
//   clock             the felt asks per timer (`feltClock`: session time solo,
//                     the host's wall clock at a shared table, #71); the
//                     headless driver only ever runs a shared table, so wall.
//   playMove,
//   playAnnouncement  the felt animates, logs and saves; headless publishes
//                     through `host.applyLocal` and nothing else.
//   onError           the felt's own log line; the party lobby's notice.
//   identityOf        both read `session.seating` first; the fallback differs
//                     (the felt: "Seat N", a bot unless it is this device's;
//                     headless: the party's name for the seat, always a bot).
//   epoch             the felt's epoch is still a module slot in table.js, so
//                     it passes it; a party session carries its own, which is
//                     the default. #225 (TableSession as sole owner) moves the
//                     felt's onto its session and this argument goes away.
//   announcementsFor  the felt passes its view-aware wrapper (a joiner's view
//                     carries the host's list); the default is the engine's,
//                     which is all a host-side session ever holds.
//
// `session` is a THUNK, the same convention every carved seam of table.js
// uses: the felt's driver is built once and outlives every match the tab
// plays, so the session is asked for at fire time, never captured.

import { actingSeats, announcementsFor as enumerateAnnouncementsFor } from '../engine/context.js';
import { createSeatLens } from '../players/seats.js';
import { loadSettings } from '../arcade/storage.js';
import { currentDelayMs } from './statusBar.js';

/**
 * The option object for `createBotDriver`, from a session and the seams that
 * differ between the felt and the headless driver.
 *
 * @param session  () => the match session, or null between matches
 * @param seams    { clock, identityOf, playMove, playAnnouncement, onError,
 *                   epoch?, announcementsFor? } — see the header
 */
export function botDriverSeams(session, seams = {}) {
  const {
    clock,
    epoch = () => session().epoch,
    identityOf,
    announcementsFor = enumerateAnnouncementsFor,
    playMove,
    playAnnouncement,
    onError,
  } = seams;
  // NO DEFAULT CLOCK, deliberately. A default would be a fixed answer to "which
  // clock", and a fixed answer is the #71 bug: the felt's driver has to ask the
  // match per timer (tests/repo-gates.test.js).
  const hooks = { identityOf, playMove, playAnnouncement, onError };
  const missing = [
    ...(clock ? [] : ['clock']),
    ...Object.keys(hooks).filter((name) => typeof hooks[name] !== 'function'),
  ];
  if (missing.length) {
    throw new TypeError(`botDriverSeams needs ${missing.join(', ')} — the seams that differ between the felt and the headless driver`);
  }
  return {
    clock,
    currentEpoch: epoch,
    // READ FRESH, NOT OFF A SNAPSHOT — both of these. The new-game sheet can
    // change either between two matches: deal a Sharp game straight after a
    // Steady one, or a Slow one after a Brisk one, and a snapshot taken when
    // the table was initialised would still say Steady and Brisk. The driver
    // asks at fire time (src/ui/botDriver.js) precisely so both can be answered
    // late.
    botDelayMs: () => currentDelayMs(),
    // THE HOST'S SETTING, FOR EVERY BOT AT ITS TABLE. Whoever is hosting owns
    // the house players, the same way they own the turn clock — and a joiner
    // whose own dial said something else would otherwise be arguing with the
    // only device that actually runs the chooser.
    difficulty: () => loadSettings().botDifficulty,
    // The house moves the seats this lens says it PLAYS — bots and empties,
    // never a joiner's chair (src/players/seats.js).
    me: createSeatLens(() => session()?.seats ?? null),
    identityOf,
    actingSeatsOf: actingSeats,
    announcementsFor,
    playMove,
    playAnnouncement,
    onError,
  };
}
