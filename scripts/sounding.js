import api, {LEVELS} from './sounding-api.js';
import {onGrid} from './air-api.js';
import {SOUNDING_CACHE_SECONDS, STORAGE_KEYS} from './config/defaults.js';
import {remembered, remember} from './lib/cache.js';
import {isNumber} from './lib/numbers.js';
import {valueAt} from './lib/series-time.js';

/**
 * The modelled air, held and shaped for the windgram.
 *
 * Kept deliberately thin. Everything this returns is something no sensor on the
 * hillside can report, and everything a sensor *can* report is left to the
 * sensor — so there is no temperature here below the top station, no wind at
 * all, and no sunlight except the one figure used to work out what share of it
 * becomes heat.
 *
 * Cached by grid square like the air quality, and for the same reason: the model
 * publishes hourly, so asking more often than that re-reads the same numbers.
 */

/**
 * How far a column may sit from a published hour and still take its value.
 *
 * A full hour rather than half of one, which matters at exactly one place: the
 * right-hand edge. The drawing runs to the last reading a station logged, and
 * the model runs to the last hour it published — so the newest column, which is
 * the one anybody is actually looking at, can sit most of an hour past the last
 * modelled hour. At half an hour it lost its air aloft and quietly fell back to
 * extrapolating, which is the one column where that matters most.
 */
const ALIGN_TOLERANCE = 60 * 60 * 1000;

// Heat that goes into evaporating water rather than warming the air still adds
// buoyancy, because water vapour is lighter than air — but only a little. This
// is 0.61 × cp / Lv × T from the virtual heat flux, at a typical surface
// temperature, which is where the Canadian RASP gets its own figure.
const LATENT_SHARE = 0.074;

// Bounds on how much of the sunlight is allowed to become heat in the air. The
// model occasionally reports a flux against almost no sunlight at dawn and dusk,
// which divides out to a nonsense share; these keep one bad hour from turning
// into a thermal that never happened.
const MINIMUM_SHARE = 0.02;
const MAXIMUM_SHARE = 0.9;

// Below this there is not enough sun for the ratio to mean anything.
const USABLE_SUN = 20;

export class Sounding {
    constructor() {
        this.inFlight = new Map();
    }

    /**
     * The modelled air over one point, from cache when it is fresh enough.
     *
     * Resolves to null rather than rejecting. The windgram drew itself without
     * any of this before and must still be able to: what this adds is accuracy
     * above the top station, not the drawing itself.
     *
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<?Object>} The shaped model, or null
     */
    async load(latitude, longitude) {
        if (!isNumber(latitude) || !isNumber(longitude)) return null;

        const key = STORAGE_KEYS.sounding(onGrid(latitude), onGrid(longitude));
        // The value, null to hold off after a failed read, or undefined to go
        // and ask. See `lib/cache.js`.
        const held = remembered(key, 'sounding', SOUNDING_CACHE_SECONDS);

        if (held !== undefined) return held;

        if (this.inFlight.has(key)) return this.inFlight.get(key);

        const request = this.fetchSounding(latitude, longitude)
            .then(sounding => {
                // Remembered either way: a failure is an answer too, and asking
                // again a minute later is how a rate limit becomes a rate limit.
                remember(key, 'sounding', sounding);
                return sounding;
            })
            .finally(() => this.inFlight.delete(key));

        this.inFlight.set(key, request);

        return request;
    }

    /**
     * Reads both halves and shapes them into one model.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<?Object>} The shaped model, or null when neither answered
     */
    async fetchSounding(latitude, longitude) {
        const [profile, surface] = await api.readBoth(latitude, longitude);

        return this.shape(profile, surface);
    }

    /**
     * Turns the two responses into times, levels and shares.
     *
     * The two models are on the same hourly grid, but they are separate requests
     * and either may be missing, so the profile's clock is taken as the model's
     * clock and the surface figures are matched onto it.
     *
     * @param {?Object} profile - The sounding response
     * @param {?Object} surface - The surface energy response
     * @returns {?Object} times, levels, cloud and share, or null
     */
    shape(profile, surface) {
        const times = (profile ?? surface)?.hourly?.time;
        if (!times?.length) return null;

        const milliseconds = times.map(seconds => seconds * 1000);

        return {
            times: milliseconds,
            levels: this.levelsFrom(profile),
            cloud: this.column(profile?.hourly?.cloud_cover, times.length),
            share: this.shares(surface, milliseconds)
        };
    }

    /**
     * One value per hour, with anything unusable left as a gap.
     * @param {?Array} values - A column from a response
     * @param {number} length - How many hours are expected
     * @returns {Array<?number>} The column
     */
    column(values, length) {
        return Array.from({length}, (unused, i) =>
            isNumber(values?.[i]) ? Number(values[i]) : null);
    }

    /**
     * The pressure levels, each with its temperature and the height it sat at.
     *
     * A pressure level is not a fixed altitude — 700 hPa is several hundred
     * metres higher on a warm afternoon than on a cold morning — so the height
     * is read per hour rather than assumed.
     *
     * @param {?Object} profile - The sounding response
     * @returns {Object[]} One entry per level, empty when there is no profile
     */
    levelsFrom(profile) {
        const hourly = profile?.hourly;
        if (!hourly?.time?.length) return [];

        return LEVELS
            .map(pressure => ({
                pressure,
                temps: this.column(hourly[`temperature_${pressure}hPa`], hourly.time.length),
                heights: this.column(hourly[`geopotential_height_${pressure}hPa`], hourly.time.length)
            }))
            // A level the model does not carry is dropped rather than kept as a
            // column of gaps that every reader then has to skip.
            .filter(level => level.temps.some(isNumber) && level.heights.some(isNumber));
    }

    /**
     * What share of the sunlight became heat in the air, hour by hour.
     *
     * The point of taking a ratio rather than the flux itself: the model's
     * sunlight is what it forecast for this square, and the station's is what a
     * pyranometer actually recorded through today's smoke. Dividing one model
     * number by another leaves a property of the *ground* — how wet it is, what
     * is growing on it — which the model is far better placed to know than we
     * are, and which changes slowly enough that an hour-old figure still holds.
     *
     * @param {?Object} surface - The surface energy response
     * @param {number[]} times - The model's clock, in milliseconds
     * @returns {Array<?number>} One share per hour
     */
    shares(surface, times) {
        const hourly = surface?.hourly;
        if (!hourly?.time?.length) return times.map(() => null);

        const theirs = hourly.time.map(seconds => seconds * 1000);
        const sensible = this.column(hourly.sensible_heat_flux, hourly.time.length);
        const latent = this.column(hourly.latent_heat_flux, hourly.time.length);
        const sunlight = this.column(hourly.shortwave_radiation, hourly.time.length);

        return times.map(time => {
            const heat = valueAt(theirs, sensible, time, ALIGN_TOLERANCE);
            const damp = valueAt(theirs, latent, time, ALIGN_TOLERANCE);
            const sun = valueAt(theirs, sunlight, time, ALIGN_TOLERANCE);

            if (heat === null || sun === null || sun < USABLE_SUN) return null;

            // The virtual heat flux: the heat that actually drives buoyancy,
            // which is mostly the sensible part plus a little of the latent.
            const flux = heat + LATENT_SHARE * (damp ?? 0);
            if (flux <= 0) return null;

            return Math.min(MAXIMUM_SHARE, Math.max(MINIMUM_SHARE, flux / sun));
        });
    }

    /**
     * The modelled profile at one moment, above a given height.
     *
     * Read from the lowest station rather than the highest, because the model is
     * now used for the *shape* of the air between the stations as well as for
     * the air above them. What it is not used for is the temperature: see
     * `anchored` in `rasp.js`, which holds the measurements and borrows only the
     * structure between them.
     *
     * @param {?Object} sounding - A shaped model
     * @param {number} time - The moment being drawn, in milliseconds
     * @param {number} above - Return levels higher than this, in metres
     * @returns {Object[]} Ascending {elevation, temp, modelled}
     */
    profileAt(sounding, time, above) {
        if (!sounding?.levels?.length) return [];

        return sounding.levels
            .map(level => ({
                elevation: valueAt(sounding.times, level.heights, time, ALIGN_TOLERANCE),
                temp: valueAt(sounding.times, level.temps, time, ALIGN_TOLERANCE),
                modelled: true
            }))
            .filter(level => isNumber(level.elevation) && isNumber(level.temp)
                && level.elevation > above)
            .sort((a, b) => a.elevation - b.elevation);
    }

    /**
     * The share of sunlight becoming heat at one moment.
     * @param {?Object} sounding - A shaped model
     * @param {number} time - The moment being drawn, in milliseconds
     * @returns {?number} The share, or null when the model does not say
     */
    shareAt(sounding, time) {
        if (!sounding?.times?.length) return null;

        return valueAt(sounding.times, sounding.share, time, ALIGN_TOLERANCE);
    }

    /**
     * The modelled cloud cover at one moment.
     * @param {?Object} sounding - A shaped model
     * @param {number} time - The moment being drawn, in milliseconds
     * @returns {?number} Percent, or null when the model does not say
     */
    cloudAt(sounding, time) {
        if (!sounding?.times?.length) return null;

        return valueAt(sounding.times, sounding.cloud, time, ALIGN_TOLERANCE);
    }
}

const sounding = new Sounding();
export default sounding;
