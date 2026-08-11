import api, {FORECAST_LEVELS} from './rasp-api.js';
import {FORECAST_CACHE_SECONDS, STORAGE_KEYS} from './config/defaults.js';
import {readJson, writeJson} from './lib/storage.js';
import {isNumber} from './lib/numbers.js';
import {valueAt} from './lib/series-time.js';

/**
 * The forecast, held and shaped for the windgram.
 *
 * The mirror of `sounding.js`, and deliberately built the same way — cached by
 * place, resolving to null rather than rejecting, shaped into milliseconds
 * before anything else sees it. The differences are all about what is being
 * asked for: this one looks forward rather than back, wants the whole column
 * rather than only the part above the top station, and carries the ground it
 * was answered for, because the terrain under a forecast is the model's rather
 * than a station's.
 */

/**
 * How far a column may sit from a published hour and still take its value.
 *
 * The two halves are on the same hourly grid, so this only has to absorb a
 * model that starts an hour later than the other. Anything further apart is a
 * gap worth showing.
 */
const ALIGN_TOLERANCE = 60 * 60 * 1000;

export class Forecast {
    constructor() {
        this.inFlight = new Map();
    }

    /**
     * The forecast over one point, from cache when it is fresh enough.
     *
     * Half an hour, which is longer than it sounds. HRDPS runs four times a day
     * and takes a couple of hours to publish, so most re-reads inside that
     * window would return the identical numbers; what the cache is really
     * protecting against is a reader leaving the page open and refreshing it
     * every minute.
     *
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<?Object>} The shaped forecast, or null
     */
    async load(latitude, longitude) {
        if (!isNumber(latitude) || !isNumber(longitude)) return null;

        const key = STORAGE_KEYS.forecast(latitude, longitude);
        const cached = readJson(key);
        const age = (Date.now() - (cached?.fetchedAt ?? 0)) / 1000;

        if (cached?.forecast && age < FORECAST_CACHE_SECONDS) return cached.forecast;

        if (this.inFlight.has(key)) return this.inFlight.get(key);

        const request = this.fetchForecast(latitude, longitude)
            .then(forecast => {
                if (forecast) writeJson(key, {fetchedAt: Date.now(), forecast});
                return forecast;
            })
            .finally(() => this.inFlight.delete(key));

        this.inFlight.set(key, request);

        return request;
    }

    /**
     * Reads both halves and shapes them into one forecast.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<?Object>} The shaped forecast, or null when nothing answered
     */
    async fetchForecast(latitude, longitude) {
        const [profile, flux] = await api.readBoth(latitude, longitude);

        return this.shape(profile, flux);
    }

    /**
     * Turns the two responses into one forecast.
     *
     * The profile's clock is the forecast's clock and the fluxes are matched
     * onto it, because the profile is the half that cannot be done without.
     *
     * @param {?Object} profile - The forecast profile response
     * @param {?Object} flux - The surface energy response
     * @returns {?Object} The shaped forecast, or null
     */
    shape(profile, flux) {
        const hourly = profile?.hourly;
        const seconds = hourly?.time;
        if (!seconds?.length) return null;

        const times = seconds.map(value => value * 1000);
        const length = seconds.length;

        return {
            times,
            // The site's own offset from UTC for these days, which is what puts
            // the flying hours along the bottom of the drawing. Taken from the
            // response rather than from the reader's own clock: somebody
            // checking Cooper's from another timezone is asking about Cooper's
            // afternoon, not their own.
            offset: Number(profile.utc_offset_seconds ?? 0) * 1000,
            // The ground the model answered for. Every height in the drawing is
            // above sea level, so this is what turns them into heights a pilot
            // can read as "above launch".
            elevation: isNumber(profile.elevation) ? Number(profile.elevation) : null,
            surface: {
                temp: this.column(hourly.temperature_2m, length),
                dewpt: this.column(hourly.dew_point_2m, length),
                windSpeed: this.column(hourly.wind_speed_10m, length),
                windDir: this.column(hourly.wind_direction_10m, length),
                // Hectopascals as published; pascals for the physics, kilopascals
                // for the strip. Converted once, here, rather than at each reader.
                pressure: this.column(hourly.surface_pressure, length)
                    .map(value => value === null ? null : value * 100),
                seaLevel: this.column(hourly.pressure_msl, length)
                    .map(value => value === null ? null : value / 10),
                cloud: this.column(hourly.cloud_cover, length),
                rain: this.column(hourly.precipitation, length)
            },
            levels: this.levelsFrom(hourly, length),
            ...this.fluxesFrom(flux, times)
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
     * The pressure levels, each with everything read at it.
     * @param {Object} hourly - The hourly block of the profile response
     * @param {number} length - How many hours are expected
     * @returns {Object[]} One entry per level the model actually carries
     */
    levelsFrom(hourly, length) {
        return FORECAST_LEVELS
            .map(pressure => ({
                pressure,
                heights: this.column(hourly[`geopotential_height_${pressure}hPa`], length),
                temps: this.column(hourly[`temperature_${pressure}hPa`], length),
                humidity: this.column(hourly[`relative_humidity_${pressure}hPa`], length),
                windSpeed: this.column(hourly[`wind_speed_${pressure}hPa`], length),
                windDir: this.column(hourly[`wind_direction_${pressure}hPa`], length)
            }))
            // A level the model does not carry is dropped rather than kept as a
            // column of gaps that every reader then has to skip.
            .filter(level => level.temps.some(isNumber) && level.heights.some(isNumber));
    }

    /**
     * The surface fluxes, matched onto the profile's clock.
     * @param {?Object} flux - The surface energy response
     * @param {number[]} times - The profile's clock, in milliseconds
     * @returns {Object} sensible and latent columns, gaps where nothing lines up
     */
    fluxesFrom(flux, times) {
        const hourly = flux?.hourly;
        const empty = {sensible: times.map(() => null), latent: times.map(() => null)};

        if (!hourly?.time?.length) return empty;

        const theirs = hourly.time.map(seconds => seconds * 1000);
        const sensible = this.column(hourly.sensible_heat_flux, hourly.time.length);
        const latent = this.column(hourly.latent_heat_flux, hourly.time.length);

        return {
            sensible: times.map(time => valueAt(theirs, sensible, time, ALIGN_TOLERANCE)),
            latent: times.map(time => valueAt(theirs, latent, time, ALIGN_TOLERANCE))
        };
    }
}

const forecast = new Forecast();
export default forecast;
