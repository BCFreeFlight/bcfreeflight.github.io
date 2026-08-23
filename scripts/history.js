import api from './wu-api.js';
import {SERIES, observationFrom} from './config/series.js';
import {HISTORY_CACHE_SECONDS, STORAGE_KEYS} from './config/defaults.js';
import {readJson, writeJson} from './lib/storage.js';
import {isNumber} from './lib/numbers.js';

/**
 * Today's readings, over time.
 *
 * Weather Underground publishes every personal station's own day in five-minute
 * buckets — the same data behind the graphs on wunderground.com. Each bucket
 * carries a high, a low and an average; which of them to read is a property of
 * the measurement, and lives with it in the series configuration.
 *
 * The response is trimmed to the measurements the page charts before it is
 * cached, because the raw day for one station is over a hundred kilobytes and
 * three of those would crowd localStorage for no gain.
 */

export class History {
    /**
     * Today's readings for one station, from cache when it is fresh enough.
     *
     * How long a day is held is the station's own setting: the launch being
     * watched comes back at the bucket cadence, and the reference stations that
     * only feed the lapse rate are held for half an hour. Floored at the bucket
     * cadence either way, because asking more often than the buckets arrive
     * only re-reads the same hundred kilobytes of day.
     *
     * @param {string} stationId - The Weather Underground station id
     * @param {number} [cacheSeconds=HISTORY_CACHE_SECONDS] - The station's own timeout
     * @returns {Promise<?Object>} times, values, latest and the day's bounds, or null
     */
    async load(stationId, cacheSeconds = HISTORY_CACHE_SECONDS) {
        const cacheKey = STORAGE_KEYS.day(stationId);
        const cached = readJson(cacheKey);
        const age = (Date.now() - (cached?.fetchedAt ?? 0)) / 1000;
        const timeout = Math.max(cacheSeconds || 0, HISTORY_CACHE_SECONDS);

        if (cached?.day && age < timeout) {
            return cached.day;
        }

        const day = await this.fetchDay(stationId);
        if (!day) return null;

        if (!writeJson(cacheKey, {fetchedAt: Date.now(), day})) {
            console.error(`Could not cache the day for ${stationId}.`);
        }

        return day;
    }

    /**
     * Reads a station's day and trims it to the charted measurements.
     * @param {string} stationId - The Weather Underground station id
     * @returns {Promise<?Object>} times, values, latest, dayStart and dayEnd
     */
    async fetchDay(stationId) {
        let rows;

        try {
            rows = (await api.day(stationId))?.observations;
        } catch (error) {
            console.error(`Could not read the day for ${stationId}:`, error);
            return null;
        }

        if (!rows?.length) return null;

        const times = rows.map(row => row.epoch * 1000);
        const values = {};

        for (const series of SERIES) {
            // Anything non-numeric becomes a gap rather than a zero, so a
            // station that reports nothing draws no line instead of a flat one
            // along the floor.
            const column = rows.map(row => {
                const value = series.read(row);
                return isNumber(value) ? Number(value) : null;
            });

            // Drop a measurement the station never reports, so its chip does
            // not offer an empty line.
            if (column.some(value => value !== null)) values[series.key] = column;
        }

        // The newest bucket, which is also every tile on the page. Picked by
        // its own timestamp rather than by position: a page of readings is not
        // worth betting on the order a response happened to arrive in.
        const newest = rows.reduce((latest, row) => (row.epoch > latest.epoch ? row : latest), rows[0]);

        return {times, values, latest: observationFrom(newest), ...this.dayBounds(rows[0])};
    }

    /**
     * Midnight to midnight in the station's own day.
     *
     * Anchoring the axis to the whole day rather than to the readings means a
     * station that came online at eight in the morning lines up with one that
     * has been running since midnight, and the gap reads as the outage it is.
     *
     * @param {Object} row - Any bucket from the day
     * @returns {Object} dayStart and dayEnd, in milliseconds
     */
    dayBounds(row) {
        // obsTimeLocal is the station's local wall clock; pairing it with its
        // own epoch gives the offset without needing a timezone library.
        const local = Date.parse(`${row.obsTimeLocal.replace(' ', 'T')}Z`);
        const offset = local - row.epoch * 1000;
        const dayStart = Math.floor(local / 86400000) * 86400000 - offset;

        return {dayStart, dayEnd: dayStart + 86400000, offset};
    }
}

const history = new History();
export default history;
