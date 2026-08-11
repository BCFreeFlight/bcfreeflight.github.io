import api, {onGrid} from './air-api.js';
import * as bands from './config/bands.js';
import {AIR_CACHE_SECONDS, STORAGE_KEYS} from './config/defaults.js';
import {remembered, remember} from './lib/cache.js';
import {band, isNumber} from './lib/numbers.js';

/**
 * The air over a site, now and through the day.
 *
 * Where the stations come from the configuration, this comes from the stations:
 * every observation carries the coordinates it was taken at, so nothing has to
 * be written down twice and a station that moves takes its air quality with it.
 *
 * Two stations near each other resolve to the same grid square and therefore to
 * the same cache entry, so a site with three stations makes one or two requests
 * rather than three. Requests already in flight are shared for the same reason:
 * the tiles and the chart both ask, at the same moment, on every page load.
 */

export class AirQuality {
    constructor() {
        this.inFlight = new Map();
    }

    /**
     * The air over one point, from cache when it is fresh enough.
     *
     * Resolves to null rather than rejecting: air quality is an extra reading
     * beside the weather, and a page that has wind and temperature to show must
     * not be taken down by the absence of an air quality number.
     *
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<?Object>} A reading, or null
     */
    async load(latitude, longitude) {
        if (!isNumber(latitude) || !isNumber(longitude)) return null;

        const key = STORAGE_KEYS.air(onGrid(latitude), onGrid(longitude));
        // The value, null to hold off after a failed read, or undefined to go
        // and ask. See `lib/cache.js`.
        const held = remembered(key, 'air', AIR_CACHE_SECONDS);

        if (held !== undefined) return held;

        // Both the tiles and the chart ask for the same square at once. Without
        // this they would each start their own request and each write the answer.
        if (this.inFlight.has(key)) return this.inFlight.get(key);

        const request = this.fetchAir(latitude, longitude)
            .then(air => {
                // Remembered either way: a failure is an answer too, and asking
                // again a minute later is how a rate limit becomes a rate limit.
                remember(key, 'air', air);
                return air;
            })
            .finally(() => this.inFlight.delete(key));

        this.inFlight.set(key, request);

        return request;
    }

    /**
     * Reads the service and shapes what comes back.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<?Object>} A reading, or null when the service will not answer
     */
    async fetchAir(latitude, longitude) {
        let data;

        try {
            data = await api.read(latitude, longitude);
        } catch (error) {
            console.error(`Could not read the air over ${latitude}, ${longitude}:`, error);
            return null;
        }

        return this.shape(data);
    }

    /**
     * Turns a response into the shape the page reads.
     *
     * The hourly columns are kept beside their times in milliseconds, which is
     * what the chart plots in, and anything non-numeric becomes a gap rather
     * than a zero — the same rule the station history follows, and for the same
     * reason: a missing hour must not draw a line along the floor.
     *
     * @param {?Object} data - A response from the service
     * @returns {?Object} usAqi, pm25, times and the hourly columns, or null
     */
    shape(data) {
        const times = data?.hourly?.time;
        if (!times?.length) return null;

        const column = values => times.map((time, i) =>
            isNumber(values?.[i]) ? Number(values[i]) : null);

        return {
            // What the service actually answered about, which is the grid
            // square rather than the point that was asked for.
            latitude: data.latitude,
            longitude: data.longitude,
            usAqi: isNumber(data.current?.us_aqi) ? Number(data.current.us_aqi) : null,
            pm25: isNumber(data.current?.pm2_5) ? Number(data.current.pm2_5) : null,
            at: isNumber(data.current?.time) ? data.current.time * 1000 : null,
            times: times.map(seconds => seconds * 1000),
            hourly: {
                usAqi: column(data.hourly.us_aqi),
                pm25: column(data.hourly.pm2_5)
            }
        };
    }

    /**
     * What an index means, in words.
     * @param {?number} usAqi - A US AQI reading
     * @returns {?Object} The matching band, or null when there is no reading
     */
    describe(usAqi) {
        return isNumber(usAqi) ? band(bands.AIR_QUALITY, usAqi) : null;
    }
}

const air = new AirQuality();
export default air;
