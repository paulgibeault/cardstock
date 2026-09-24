// ENGINE ANSWERS A TEST IS ALLOWED TO ASK FOR, RATHER THAN RE-DERIVE.
//
// Sixteen tests carried their own copy of
//   `template.actingSeats ? template.actingSeats(makeCtx(state)) : [state.turn.seat]`
// — the felt's rule, hand-written, sixteen times. None of the copies had the
// "a finished match acts on nobody" guard that src/engine/context.js's
// `actingSeats` has had since #208, so a test that read past gameOver was
// measuring a seat the real table would never have offered.
//
// So this is a re-export, not a reimplementation, and that is the whole point:
// a test asks the engine what the engine tells the felt. It lives under
// tests/fixtures/ so the import reads as "the shared test helper" and so a
// seventeenth copy has somewhere obvious to not be written.

export { actingSeats, announcementsFor, makeCtx } from '../../src/engine/context.js';
