import {readJson, writeJson} from './storage.js';

/**
 * Holding on to what a service already answered.
 *
 * Three readers — the air quality, the sounding aloft, and the forecast — ask
 * the same service for things that change hourly at most, from a page that
 * refreshes every minute. Each had its own copy of this, identical apart from
 * the name of the field it kept, so they are one thing now.
 *
 * The part that was missing from all three: a read that *failed* was not
 * remembered at all, so a page left open through an outage asked again on every
 * refresh. Open-Meteo answers 429 when it wants to be left alone, and the old
 * behaviour was to take that as an invitation to ask again a minute later — for
 * as long as the page stayed open.
 */

/**
 * How long a failed read is respected before trying again.
 *
 * Short enough that a blip does not cost a reader their forecast for the rest
 * of the hour, long enough that a rate limit is not answered by more requests.
 */
export const FAILURE_BACKOFF_SECONDS = 5 * 60;

/**
 * What is held for a key, if anything usable is.
 *
 * Three answers, and the caller has to tell them apart: the value, `null` for
 * "asked recently and got nothing, do not ask again yet", and `undefined` for
 * "nothing held, go and read it".
 *
 * @param {string} key - Where it is kept
 * @param {string} field - What the value is called inside the record
 * @param {number} seconds - How long a good answer stays good
 * @returns {*} The value, null to hold off, or undefined to read
 */
export function remembered(key, field, seconds) {
    const cached = readJson(key);
    if (!cached) return undefined;

    const age = (Date.now() - (cached.fetchedAt ?? 0)) / 1000;

    if (cached[field]) return age < seconds ? cached[field] : undefined;

    return age < FAILURE_BACKOFF_SECONDS ? null : undefined;
}

/**
 * Keeps what a service answered, including when that was nothing.
 * @param {string} key - Where to keep it
 * @param {string} field - What to call the value inside the record
 * @param {*} value - The answer, or null when there was not one
 * @returns {void}
 */
export function remember(key, field, value) {
    writeJson(key, {fetchedAt: Date.now(), [field]: value ?? null});
}
