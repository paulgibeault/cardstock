// THE DAILY'S CALENDAR: what a day is called, and how that name becomes a seed.
//
// Four string functions, no game in them. They live beside the rest of the
// arcade platform layer (storage.js's `daily.*` keys, arcade-rng.js's
// `dailyDateStr`) because that is what they are about — a date, a storage key,
// a seed string — and not about contracts, decks or melds. The generator that
// turns a seed into a ladder is a contract-rummy concern and sits in
// src/templates/contract-rummy-daily.js; it imports `dailySeedFor` from here.

import { dailyDateStr } from '../engine/arcade-rng.js';

/** A YYYY-MM-DD string, or null. Structural: this reaches a storage key. */
export function isDailyDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The day's seed: `<packId>|<YYYY-MM-DD>`, on the player's own calendar.
 *
 * DEVICE-LOCAL, which is the platform rule (`dailyDateStr` says why): a daily
 * rolls at the player's midnight, not at UTC's. It seeds the ladder AND the
 * deal, so "the same puzzle everywhere" is one string rather than two
 * agreements.
 *
 * @param date a Date, a YYYY-MM-DD string, or nothing for today.
 */
export function dailySeedFor(packId, date) {
  const day = isDailyDate(date) ? date : dailyDateStr(date);
  return `${packId}|${day}`;
}

/** The calendar day a `dailySeedFor` string names, or null for anything else. */
export function dateOfDailySeed(seed) {
  if (typeof seed !== 'string') return null;
  const day = seed.slice(seed.indexOf('|') + 1);
  return isDailyDate(day) ? day : null;
}

/** The calendar day before `dateStr`. Date-only arithmetic, so UTC is safe here. */
export function previousDate(dateStr) {
  if (!isDailyDate(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() - 1);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}`;
}
