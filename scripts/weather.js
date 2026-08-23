import history from './history.js';
import * as bands from './config/bands.js';
import {pointAt} from './config/compass.js';
import {OBSERVATION_STALE_SECONDS} from './config/defaults.js';
import {band, isNumber} from './lib/numbers.js';
import {lapseRate} from './lib/lapse.js';

/**
 * Reading the stations, and saying what the readings mean.
 *
 * A reading is the newest five-minute bucket of the station's own day — the
 * same day the charts are drawn from, so one request serves both. Weather
 * Underground also publishes a current-observation endpoint, one instant per
 * request; the site no longer reads it, because an instant is whatever gust or
 * lull happened to be passing and the bucket beside it is already averaged.
 */

/**
 * @typedef {Object} UkHybrid
 * @property {number} windSpeed - Wind speed in km/h
 * @property {number} windGust - Wind gust in km/h
 * @property {number} temp - Temperature in Celsius
 * @property {number} precipTotal - Total precipitation in mm
 * @property {number} heatIndex - Heat index in Celsius
 * @property {number} dewpt - Dew point in Celsius
 * @property {number} windChill - Wind chill in Celsius
 * @property {number} pressure - Barometric pressure in hPa
 * @property {number} precipRate - Precipitation rate in mm/hr
 */

/**
 * @typedef {Object} Observation
 * @property {string} obsTimeUtc - Observation time in UTC
 * @property {number} lat - Latitude
 * @property {number} lon - Longitude
 * @property {UkHybrid} uk_hybrid - UK hybrid measurements
 * @property {number} winddir - Wind direction in degrees
 * @property {number} humidity - Humidity percentage
 * @property {number} uv - UV index
 * @property {number} solarRadiation - Solar radiation in W/m²
 */

/**
 * Clears the readings the retired current-observation endpoint left behind.
 *
 * Every reading used to be cached per station under `weather_cache_<id>`.
 * Anyone who has visited the site still has those keys, in the same storage
 * budget as the days that replaced them — and a day is the only thing the site
 * now stores at size, so the space is worth taking back. Removable once a
 * release has gone by.
 *
 * Bare `localStorage` access rather than `lib/storage.js` because it is the
 * whole keyring being read, not one entry, which is also why it needs the
 * `try`: enumerating storage throws outright in some privacy modes.
 *
 * @returns {void}
 */
export function forgetCachedObservations() {
    try {
        Object.keys(localStorage)
            .filter(key => key.startsWith('weather_cache_'))
            .forEach(key => localStorage.removeItem(key));
    } catch (error) {
        // Nothing here is worth an exception on a page that has readings to draw.
    }
}

forgetCachedObservations();

/**
 * Whether a reading is recent enough to be showing.
 *
 * The buckets arrive every five minutes, so a station that has not published
 * one in twenty minutes has stopped rather than being between readings. Asked
 * of the reading itself rather than of the request that fetched it: a day still
 * loads for a station that died at noon, and every bucket in it is real.
 *
 * @param {?Object} observation - A station reading
 * @param {number} [now=Date.now()] - The moment to measure against
 * @returns {boolean} Whether the station counts as still reporting
 */
export function isFresh(observation, now = Date.now()) {
    const observedAt = Date.parse(observation?.obsTimeUtc ?? '');

    if (Number.isNaN(observedAt)) return false;

    return (now - observedAt) / 1000 < OBSERVATION_STALE_SECONDS;
}

/**
 * Main Weather class for handling weather data and calculations
 */
export class Weather {
    /**
     * Loads every station of a site.
     *
     * One request per station serves both the readings and the chart under
     * them: the day is read here, the charts take the same cached day, and the
     * readings are its newest bucket. Stations are read and interpreted
     * independently, each with its own cache timeout, so one going dark never
     * takes the others down with it. Each station keeps its configuration
     * alongside its reading, which is what lets the pages stay free of
     * hardcoded station ids.
     *
     * The day is kept on the entry even when the station has stopped
     * reporting. Its readings are stale and every page hides them, but the
     * hours it did record are still worth drawing — a station that quit at noon
     * is exactly the one whose morning you want to see.
     *
     * @param {Object[]} stations - Normalised stations from the site configuration
     * @return {Promise<Object[]>} One entry per station: station, day, observation, metrics, online
     */
    async loadStations(stations) {
        return Promise.all(stations.map(async station => {
            const day = await this.safeDay(station);
            const observation = day?.latest ?? null;

            return {
                station,
                day,
                observation,
                metrics: this.describeObservation(observation, station.coordinates?.elevation),
                online: isFresh(observation)
            };
        }));
    }

    /**
     * Reads one station's day, resolving to null instead of rejecting so that
     * one failing station cannot reject the whole page load.
     * @param {Object} station - A normalised station
     * @returns {Promise<?Object>} The day, or null
     */
    async safeDay(station) {
        try {
            return await history.load(station.id, station.cacheSeconds);
        } catch (error) {
            console.error(`Station ${station.id} failed to load:`, error);
            return null;
        }
    }

    /**
     * Derives the interpreted metrics for a single observation. Each metric is
     * independent: a missing reading yields nulls for that metric alone.
     * @param {?Object} observation - A single station observation
     * @param {?number} [elevationMetres=null] - Where the site says the station stands
     * @returns {Object} uvIndex, barometricPressure, dewPoint, humidity, heatIndex, windChill
     */
    describeObservation(observation, elevationMetres = null) {
        const empty = {
            uvIndex: null,
            barometricPressure: null,
            dewPoint: null,
            humidity: null,
            heatIndex: null,
            windChill: null
        };

        if (!observation) {
            return empty;
        }

        const uk = observation.uk_hybrid ?? {};

        const seaLevelPressure = isNumber(uk.pressure)
            ? this.computeSeaLevelPressure(elevationMetres ?? 0, uk.pressure)
            : null;

        return {
            uvIndex: isNumber(observation.uv) ? band(bands.UV, observation.uv) : null,

            barometricPressure: isNumber(uk.pressure) ? {
                description: band(bands.PRESSURE, seaLevelPressure).description,
                kPa: (uk.pressure / 10).toFixed(1),
                hPa: uk.pressure.toFixed(1)
            } : null,

            dewPoint: isNumber(uk.dewpt) ? {
                description: band(bands.DEW_POINT, uk.dewpt).description,
                celsius: uk.dewpt.toFixed(1)
            } : null,

            humidity: isNumber(observation.humidity) ? {
                description: band(bands.HUMIDITY, observation.humidity).description,
                percent: observation.humidity.toFixed(0)
            } : null,

            heatIndex: isNumber(uk.heatIndex) ? {
                description: band(bands.HEAT_INDEX, uk.heatIndex).description,
                celsius: uk.heatIndex.toFixed(1)
            } : null,

            windChill: isNumber(uk.windChill) ? {
                description: band(bands.WIND_CHILL, uk.windChill).description,
                celsius: uk.windChill.toFixed(1)
            } : null
        };
    }

    /**
     * Converts wind direction in degrees to cardinal/intercardinal direction
     * @param {number} degrees - Wind direction in degrees (0-360)
     * @returns {string} Cardinal/intercardinal direction (N, NNE, NE, ...)
     */
    degreesToDirection(degrees) {
        return pointAt(degrees).abbr;
    }

    /**
     * Calculates the temperature lapse rate between two stations.
     *
     * Each side is a reading and the height it was taken at, because the reading
     * does not carry one: a five-minute bucket states no elevation, so the
     * height is the site's own figure from the configuration.
     *
     * Which one is higher is decided by that height rather than by the order
     * they arrive in, so callers can hand over any pair.
     *
     * @param {?{observation: ?Object, elevationFeet: ?number}} a - One station
     * @param {?{observation: ?Object, elevationFeet: ?number}} b - The other
     * @returns {Object} lapseRate, elevDiff and the matching stability band
     */
    calculateLapseRate(a, b) {
        // Needs a reading and a height on both sides. Keep the shape stable so
        // callers can render a placeholder without null-checking every field.
        if (!isNumber(a?.observation?.uk_hybrid?.temp) || !isNumber(b?.observation?.uk_hybrid?.temp)
            || !Number.isFinite(a?.elevationFeet) || !Number.isFinite(b?.elevationFeet)) {
            return {lapseRate: null, elevDiff: null, details: null};
        }

        const [upper, lower] = a.elevationFeet >= b.elevationFeet ? [a, b] : [b, a];
        const elevDiffFeet = upper.elevationFeet - lower.elevationFeet;
        const rate = lapseRate(lower.observation.uk_hybrid.temp, upper.observation.uk_hybrid.temp,
            elevDiffFeet / 1000);

        return {
            lapseRate: rate.toFixed(2),
            elevDiff: Math.abs(elevDiffFeet).toFixed(1),
            details: band(bands.LAPSE, rate)
        };
    }

    /**
     * Compute sea‐level equivalent pressure from station pressure and elevation.
     *
     * Metres, because that is what the site configuration states and it is now
     * the only place a station's height comes from.
     *
     * @param {number} elevationM - Elevation in metres above sea level.
     * @param {number} pressureHpa  - Measured pressure in hPa.
     * @returns {number} Sea‐level equivalent pressure in kPa.
     */
    computeSeaLevelPressure(elevationM, pressureHpa) {
        // Standard constants
        const T0 = 288.15;       // Sea‐level standard temperature (K)
        const L = 0.0065;        // Temperature lapse rate (K/m)
        const g = 9.80665;       // Gravitational acceleration (m/s²)
        const R = 287.05;        // Specific gas constant for dry air (J/(kg·K))
        const exponent = g / (R * L);

        // Barometric formula factor
        const factor = Math.pow(
            1 - (L * elevationM) / T0,
            -exponent
        );

        return (pressureHpa * factor) / 10;
    }
}

// Export a default instance of the Weather class
const weather = new Weather();
export default weather;
