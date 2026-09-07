// What a template is called and what it looks like, WITHOUT loading it.
//
// THE LOBBY'S COST CEILING IS THAT IT NEVER LOADS A PACK (see src/ui/lobby.js).
// It draws every tile from manifests alone — no decks, no engine, no gameplay
// code — and three of the facts it needs are per-TEMPLATE rather than per-pack:
// the genre word under the name, which card art a pack gets when it does not
// name one, and whether the table can play the genre through to the end.
//
// Those three lived in three different places, each of which dragged something
// expensive in behind it: `FULLY_PLAYABLE_TEMPLATES` was exported from
// src/ui/table.js, so importing it pulled 3,000 lines of table plus the engine
// into the lobby; the genre labels were a map in lobby.js; and the default card
// style was an `if (manifest.template === 'shedding')` inside the card-style
// registry. All three had to be edited to add a fifth template.
//
// So they live here, in a module that imports NOTHING. src/templates/index.js
// stamps these fields onto each template object, so gameplay code reads them as
// `template.genreLabel` and never learns this file exists; the lobby and the
// card-style registry read the table directly, keyed by the manifest's
// `template` string, and load nothing.
//
// A template id absent from this table is a template the platform has never
// heard of: it gets the neutral genre word, the vanilla card art, and a Preview
// badge — which is exactly the right way for a fifth template to start life.

export const TEMPLATE_INFO = Object.freeze({
  shedding: {
    genreLabel: 'Shedding',
    defaultCardStyle: 'shedding',
    playable: true,
  },
  'trick-taking': {
    genreLabel: 'Trick-taking',
    defaultCardStyle: 'vanilla',
    playable: true,
  },
  'contract-rummy': {
    genreLabel: 'Rummy',
    defaultCardStyle: 'vanilla',
    playable: true,
  },
  sequencing: {
    genreLabel: 'Sequencing',
    defaultCardStyle: 'vanilla',
    playable: true,
  },
  // The fifth (#102). It started life absent from this table — which is what
  // gets a new template the neutral genre word, the vanilla card art and a
  // Preview badge — and earned its row by playing a hand from deal to game
  // over. 'Climbing' is the genre's own name (Big Two, President and Zheng
  // Shangyou are the same engine); 'Shedding' is the neighbouring genre and
  // means something else on this shelf already.
  //
  // `vanilla` rather than `classic` for the same reason trick-taking is
  // vanilla: a standard deck already resolves to `classic` before the template
  // is consulted at all (src/ui/cardStyles/index.js), so this line only ever
  // answers for a climbing pack with a deck of its own — and a deck of its own
  // is exactly the case where French pips would be the wrong guess.
  climbing: {
    genreLabel: 'Climbing',
    defaultCardStyle: 'vanilla',
    playable: true,
  },
  // The sixth (#107). Playable the day it played a full match to 121 against
  // the bot, and not before: it shipped absent from this table — the Preview
  // badge and the neutral genre word, which is the right way for a new
  // template to start — and earned the entry once
  // `tools/simulate.mjs --match cribbage` finished every game it was given.
  //
  // `classic` and not `vanilla`, which is the opposite call to climbing's
  // above and for the same reason stated the other way round: a cribbage pack
  // with a deck of its own is still a deck of French-suited cards being
  // counted to fifteen, because the counting IS the genre.
  cribbage: {
    genreLabel: 'Cribbage',
    defaultCardStyle: 'classic',
    playable: true,
  },
});

const UNKNOWN = Object.freeze({
  genreLabel: 'Card game',
  defaultCardStyle: 'vanilla',
  playable: false,
});

/** Presentation facts for a template id, from a manifest and nothing else. */
export function templateInfo(templateId) {
  return TEMPLATE_INFO[templateId] || UNKNOWN;
}
