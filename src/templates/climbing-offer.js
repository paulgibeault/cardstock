// THE TWO-HANDED OFFER DEAL (#157) — one seat count of one pack, and the only
// phase this genre has besides `play`.
//
// `rules.offer` is "deal the whole deck into N face-down piles and let the
// players pick one each"; `offerFor` below says why it exists. Split out of
// ./climbing.js because it was ONE RULE IN ELEVEN PLACES: a deal, a phase, a
// move type, a pair of zones, and a branch in ten hooks — every one of them
// reading `rules.offer` or `phase === 'choose'` again at a table that mostly
// does not declare it.
//
// So the phase owns its branches, and ./climbing.js composes them: each export
// below answers `null` (or `[]`) for a table with no offer, which is the same
// sentence "this is not my phase" in every hook rather than ten copies of
// `ctx.turn.phase === 'choose'` spread through the rules.
//
// NOTHING HERE IMPORTS ./climbing.js, and one function is the reason: the pick
// ends by starting the hand, which is the rules' own `openPlay`. It is HANDED IN
// (`applyTakeHand`, `finishChoose`), the way ./contract-rummy-ui.js takes the
// validator it checks against, so the phase and the rules it hands back to do
// not form a cycle.

/* ------------------------------------------------------------------ *
 * Two-handed: three piles, and you pick one
 * ------------------------------------------------------------------ */

/** The shared, face-down piles on offer, and the pile nobody took. */
const OFFER = 'offer';
const ASIDE = 'aside';

function offerAddress(n) {
  return `${OFFER}.${n}`;
}

/**
 * THE DEAL THIS TABLE PLAYS, or null for the ordinary one.
 *
 * `rules.offer` is "deal the whole deck into N face-down piles and let the
 * players pick one each", and it exists because the flat deal is the wrong
 * game SHORT-HANDED. `rules.deal` is thirteen at every seat count by design
 * (D-11) — a hand size is the name of the game — but at TWO seats that leaves
 * twenty-six of the fifty-two cards unseen by anybody, which is half a deck of
 * pigs and bombs that simply never turns up. Two people actually play it by
 * dealing three piles of seventeen, picking one each, and setting the third
 * aside: thirty-four cards in play instead of twenty-six, and the choice of
 * pile is a decision worth having in place of a deal nobody influences.
 *
 * `atSeats` rather than a `byPlayers` map because this is not a hand SIZE that
 * varies with the table — it is a different deal, with a phase of its own, and
 * a pack declares the one seat count it replaces the ordinary deal at.
 */
export function offerFor(rules, seats) {
  const offer = rules.offer;
  if (!offer || seats !== offer.atSeats) return null;
  return offer;
}

/**
 * `rules.offer` piles, dealt off one shuffle.
 *
 * The pile size is DERIVED rather than declared: the rule is "the whole deck,
 * split evenly", and 52 into three is seventeen each with one over. A declared
 * size would be a second number that could disagree with the deck, and the one
 * card left over is the rule's own consequence rather than a separate fact.
 * It goes face down beside the pile nobody takes — out of play, unseen, which
 * is exactly what the flat deal does with its own remainder.
 *
 * Goes through `ctx.placeDeck` for the same reason `dealHands` does — the
 * initial deal is sanctioned (src/templates/CONTRACT.md).
 */
function dealOffer(ctx, offer) {
  const ids = ctx.rng.shuffle([...ctx.pack.cardsById.keys()]);
  const per = Math.floor(ids.length / offer.piles);
  const put = (addr, id) => ctx.placeDeck(addr, [id]);
  let at = 0;
  for (let n = 1; n <= offer.piles; n++) {
    for (let i = 0; i < per; i++) put(offerAddress(n), ids[at++]);
  }
  for (; at < ids.length; at++) put(ASIDE, ids[at]);
}

/** The piles still on offer — the ones nobody has taken. */
export function openOffers(ctx) {
  const offer = offerFor(ctx.rules, ctx.seats);
  if (!offer) return [];
  const out = [];
  for (let n = 1; n <= offer.piles; n++) {
    const address = offerAddress(n);
    if (ctx.hasZone(address) && ctx.countIn(address) > 0) out.push(address);
  }
  return out;
}

/**
 * WHO PICKS FIRST, and the one decision in this rule that had to be made
 * rather than implemented (#157).
 *
 * Hand two onward is the rule everybody plays: the seat that LOST the last
 * hand picks first, and — because `laterLead` hands the lead to the seat that
 * went out — the winner gets the lead in exchange. Written as "the seat after
 * the winner", which at two seats IS the loser and at any larger table is the
 * winner picking last, so the same line serves a pack that offers piles to
 * three.
 *
 * HAND ONE IS A COIN FLIP, off the match's own seeded stream. The issue's other
 * candidate — "the player who does not hold the lowest card picks first" —
 * cannot be built, and it is worth writing down why rather than leaving it to
 * be rediscovered: at hand one the pick happens BEFORE anybody holds anything,
 * so a rule phrased over the dealt hands is a rule about a fact that does not
 * exist yet. What survives of it is the compensation, and that is already the
 * table's rule: whichever pile each player ends up with, the lowest card in
 * play leads (#156), so the first picker's advantage is answered by the lead
 * going wherever the 3♠ went. A rotation was the other option and is the bug
 * #156 just removed — `openingSeat()` is seat 0 on round one, which is the
 * human.
 */
function firstPicker(ctx, wonLast) {
  if (wonLast === null || wonLast === undefined) return ctx.rng.int(ctx.seats);
  return ctx.nextSeat(wonLast);
}

/**
 * Every seat has picked: the pile nobody took leaves the table, and the hand
 * begins.
 *
 * IT GOES TO `aside`, NOT TO `discard`, and the difference is the whole
 * information model of this game. `discard` is `visibility: 'all'` because
 * everybody watched those cards being played, and `unseenBy` — which is how the
 * bot works out whether a pig can still be chopped — counts it as SEEN. Seventeen
 * cards nobody has ever looked at are not that. `aside` is hidden from everyone,
 * so the pile nobody chose stays in the pool of cards that might be anywhere,
 * which is the honest reading at a real table: you know a pile is over there,
 * and you do not know what is in it.
 */
function finishChoose(ctx, openPlay) {
  for (const address of openOffers(ctx)) {
    ctx.moveCards(ctx.cardIdsIn(address).slice(), address, ASIDE);
  }
  openPlay(ctx, ctx.var('opening') ?? null);
}

/* ------------------------------------------------------------------ *
 * The hook branches this phase owns
 * ------------------------------------------------------------------ *
 *
 * Each one answers "not my phase" — `null` for a hook that returns a value,
 * `[]` for a hook that returns a list — so ./climbing.js asks once at the top
 * of the hook and then gets on with the rules.
 */

/**
 * The two zones the offer deal adds, or none. Spread into `defaultZones`.
 */
export function offerZones(rules, seats) {
  const offer = offerFor(rules, seats);
  if (!offer) return [];
  return [
    // THE PILES ON OFFER, and only at the table that plays for them. Labelled
    // "Hand" because that is what the player is choosing — the felt draws
    // "Hand 1" over a count of seventeen, and a second pile called "Pile"
    // beside the play pile would name two different things the same.
    //
    // `visibility: 'none'` is the rule and not the dressing: nobody may look
    // into a pile before taking it, their own pick included, so the view
    // filter sends a COUNT and no ids (src/engine/view.js). `interactive`
    // keeps a hidden pile on the felt — the draw pile's precedent — because
    // it is the only control the phase has; `hideWhenEmpty` takes each one
    // away as it is taken, and takes all three away when the last is set
    // aside, so the felt stops showing a phase that is over.
    { id: OFFER, per: 'shared', count: offer.piles, visibility: 'none', layout: 'stack', order: 'stack', facing: 'down', label: 'Hand', interactive: true, hideWhenEmpty: true },
    // The pile nobody took, and the odd card the split left over. Hidden
    // from everyone and never drawn — the cards are out of play, which is
    // what the flat deal does with its own remainder by simply not dealing
    // it. Stockpile's `recycled` is the same shape of zone.
    { id: ASIDE, per: 'shared', visibility: 'none', layout: 'stack', order: 'stack', facing: 'down' },
  ];
}

/**
 * Deal the piles and open the pick, or answer false for a table that deals flat
 * — which is `beginHand`'s cue to go on and deal hands.
 *
 * @param opening the seat the round boundary decided leads, or null for
 *                `rules.firstLead`; see the parking note below.
 * @param wonLast the seat that went out last hand — the pick order needs it
 *                even where the lead rule does not.
 */
export function beginOffer(ctx, opening, wonLast) {
  const offer = offerFor(ctx.rules, ctx.seats);
  if (!offer) return false;
  dealOffer(ctx, offer);
  // PARKED, NOT DROPPED. Who leads once the hands are chosen is decided now
  // — it is the hand that just ended talking — but it cannot be acted on
  // until there are hands to lead from, and the round boundary that computed
  // it will not be run again. It is a fact of the table (everybody watched
  // the last hand end), so it is a plain public var rather than a `__` one.
  ctx.setVar('opening', opening ?? null);
  ctx.setTurnSeat(firstPicker(ctx, wonLast));
  ctx.setPhase('choose');
  return true;
}

/**
 * The whole of what this phase has to say about a move, or null for a move the
 * rules should judge themselves.
 */
export function validateOffer(ctx, move) {
  // THE CHOOSE PHASE IS A CLOSED DOOR, stated once here rather than as a
  // condition on each branch below. Nothing is in anybody's hand yet, so a
  // `playCard` would already fail on `not-in-hand` and a `pass` on
  // `must-lead` — both true, both the wrong sentence, and both an accident of
  // the order the checks happen to be written in.
  if (ctx.turn.phase === 'choose' && move.type !== 'takeHand') {
    return ctx.fail('choosing', 'Take one of the hands on offer first.');
  }

  if (move.type === 'takeHand') {
    if (ctx.turn.phase !== 'choose') return ctx.fail('not-choosing', 'The hands have already been dealt.');
    if (move.actor !== ctx.turn.seat) return ctx.fail('turn', "It's not your turn to pick.");
    const from = move.from;
    // Asked of the OPEN piles rather than of the address's shape: a pile that
    // has been taken is gone from that list, which is the same answer as "you
    // cannot have that one" without a second rule saying so.
    if (!from || !openOffers(ctx).includes(from)) {
      return ctx.fail('not-on-offer', 'That is not one of the hands on offer.');
    }
    return ctx.ok();
  }
  return null;
}

/** A pile into a hand, and the hand begun once every seat is holding one. */
export function applyTakeHand(ctx, move, openPlay) {
  const seat = move.actor;
  const cards = ctx.cardIdsIn(move.from).slice();
  ctx.moveCards(cards, move.from, ctx.zoneAddr('hand', seat));
  // A COUNT AND NO IDS. Everybody watched a pile of seventeen go into
  // somebody's hand, and that is the whole of what they watched — the ids
  // would be filtered out of the event for every other seat anyway
  // (src/engine/view.js), so putting them in would be a leak the filter
  // happens to catch rather than a fact nobody published.
  ctx.emit('handTaken', { seat, count: cards.length });
  // The last seat to pick ends the phase. Asked of the HANDS rather than
  // counted in a var: the state already knows how many seats are holding
  // cards, and a counter beside it is one more thing that can disagree.
  let everyoneHolds = true;
  for (let s = 0; s < ctx.seats; s++) {
    if (ctx.countIn(ctx.zoneAddr('hand', s)) === 0) everyoneHolds = false;
  }
  if (everyoneHolds) finishChoose(ctx, openPlay);
  else ctx.setTurnSeat(ctx.nextSeat(seat));
}

/** The moves this phase offers, or null when it is not this phase. */
export function offerMoves(ctx, seat) {
  // ONE MOVE PER PILE STILL ON OFFER — which is what makes the piles tappable
  // on the felt, because every tap target is derived from an enumerated move
  // (src/ui/interaction.js). The `from` address is the whole move: there is
  // nothing to choose about a face-down pile except which one.
  if (ctx.turn.phase === 'choose') {
    return openOffers(ctx).map((from) => ({ actor: seat, type: 'takeHand', from }));
  }
  return null;
}

/** Who may act during the pick, or null when it is not this phase. */
export function offerActingSeats(ctx) {
  // `stillIn` reads "has cards and has not passed", and in the choose phase
  // NOBODY has cards — so the unguarded answer is an empty list, which
  // tools/simulate.mjs reports as a stalled table and the felt draws as a turn
  // token pointing at nobody. The picker is the acting seat.
  if (ctx.turn.phase === 'choose') return [ctx.turn.seat];
  return null;
}

/**
 * Multi-select then commit, with a VARIABLE count — the mode this template
 * bought (src/ui/interaction.js). `pass` is the near miss and is exactly N;
 * here the count is whatever the combination is, and whether the selection is
 * a play at all is a live question the action button answers as cards go in.
 */
/*
 * PHASE-DRIVEN NOW, because the offer deal opens a phase where the hand is
 * empty and the only live control on the felt is a face-down pile (#157).
 * `take-pile` is a tap on a zone; `combination` is a gathered selection
 * committed by a button. Two genuinely different input shapes, so two modes —
 * the vocabulary is the platform's and which phase means which is this
 * template's (src/ui/interaction.js).
 *
 * THE WHOLE HOOK LIVES HERE, not a branch of it, because both answers are about
 * this phase: one is what it asks for and the other is what the rest of the game
 * asks for. ./climbing.js composes it onto the template.
 */
export function interactionMode(ctx) {
  return ctx.turn.phase === 'choose' ? 'take-pile' : 'combination';
}

/**
 * THE TABLE DURING THE PICK IS THE THREE PILES AND NOTHING ELSE (#157's
 * felt, found on a phone).
 *
 * The two-handed deal opens in `choose` with three face-down hands on offer
 * and every other pile on the felt empty — so the middle of the table drew
 * four boxes in a row: `pile`, `discard`, and the two hands still to pick
 * from. The two empty ones are not the same SHAPE as each other, because a
 * spread pile and a stack are drawn at different widths, and they are not the
 * same shape as the piles beside them either. What a player is being asked to
 * do in this phase is tell two identical face-down piles apart; a row that
 * puts two differently-sized empty boxes in front of them answers that
 * question wrongly before it is asked.
 *
 * NOT `hideWhenEmpty` ON THOSE TWO ZONES, which is the one-word version of
 * this and is wrong in ordinary play: `pile` is empty at the start of every
 * trick and is where a lead LANDS (`landing: 'play'`), so it would vanish and
 * come back once a trick, taking the drop target with it and reflowing the
 * felt under a thumb. `discard` is empty for the whole of a hand's first
 * trick for the same kind of reason. The question is not "is this pile
 * empty", it is "is this pile part of the table during THIS phase" — which is
 * a question only the template can answer, and the same split
 * `interactionMode` makes between the platform's vocabulary and the
 * template's phases.
 */
export function zoneOnFelt(ctx, address) {
  if (ctx.turn.phase !== 'choose') return null;
  return address !== 'pile' && address !== 'discard';
}

/**
 * The one event this phase emits, described — or null, which is
 * `describeEvent`'s own "I have nothing to say about this one".
 *
 * `who` and `mine` are ./climbing.js's, because naming a seat is the platform's
 * rule and there is exactly one copy of it (CONTRACT.md, "Naming a seat").
 */
export function describeOfferEvent(ev, { who, mine }) {
  if (ev.type === 'handTaken') {
    // The count, because the count is the public fact — and because the other
    // player is about to want to know how big the hand they are picking from
    // the rest of is.
    return mine(ev.seat)
      ? { text: `You took a hand of ${ev.count}`, tone: 'good' }
      : { text: `${who(ev.seat)} took a hand of ${ev.count}`, tone: 'neutral' };
  }
  return null;
}

/** The rules-page sentence this deal owes, or none. */
export function offerRuleLines(rules) {
  // WRITTEN AS A FACT ABOUT THE PACK, NOT ABOUT THIS TABLE, because this hook
  // is handed the rules and not the seat count (src/ui/rules.js) — and it
  // reads better that way anyway: a player at a four-handed table is being
  // told what happens if they sit down with one other person.
  if (!rules.offer) return [];
  return [`With ${rules.offer.atSeats} players the deck is dealt into `
    + `${rules.offer.piles} face-down hands instead: you pick one each and the rest is set `
    + 'aside. Whoever lost the last hand picks first.'];
}

/**
 * What a pile is worth to a bot, or null for a move that is not a pick.
 *
 * EVERY PILE IS WORTH THE SAME, AND THAT IS THE HONEST ANSWER (#157). A bot
 * cannot see into an offered pile any more than a player can: the zone is
 * `visibility: 'none'`, and the lookahead refuses to judge the move anyway
 * because taking a pile turns up seventeen cards the seat could not see
 * beforehand (src/engine/bot.js, `revealsHiddenCards`). Nothing public
 * distinguishes one seventeen-card face-down pile from another, so a
 * heuristic that preferred one would be reading the deck. Equal scores mean
 * the deterministic chooser takes the first pile still on offer, and a
 * persona's `mistakeRate` will sometimes take another — which is exactly as
 * much of a decision as the position contains.
 */
export function pileWorth(move) {
  return move.type === 'takeHand' ? 0 : null;
}
