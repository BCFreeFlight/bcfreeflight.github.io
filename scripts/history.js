import {WU_API_KEY} from './weather.js';

/**
 * Today's readings, over time.
 *
 * Weather Underground publishes every personal station's own day in five-minute
 * buckets — the same data behind the graphs on wunderground.com. Each bucket
 * carries a high, a low and an average; the average is what a line should be
 * drawn through, and the high is what matters for a gust.
 *
 * The response is trimmed to the measurements the page charts before it is
 * cached, because the raw day for one station is over a hundred kilobytes and
 * three of those would crowd localStorage for no gain.
 */

const HISTORY_URL = 'https://api.weather.com/v2/pws/observations/all/1day';

// The buckets arrive every five minutes, so asking more often than that only
// re-reads the same day. Stations with a shorter cache still get their current
// reading at their own cadence; this governs the chart alone.
const HISTORY_CACHE_SECONDS = 5 * 60;

/**
 * The measurements available to chart, in the order they are offered.
 *
 * `unit` decides which series can share an axis: two series measured in ºC are
 * directly comparable, a temperature and a wind speed are not. `read` pulls the
 * value out of one bucket, which is where the API's High/Low/Avg naming is
 * dealt with once.
 *
 * @type {Object[]}
 */
export const SERIES = [
    {
        key: 'temp',
        label: 'Temperature',
        unit: 'ºC',
        colour: '#d92c2c',
        group: 'temp',
        on: true,
        read: row => row.uk_hybrid?.tempAvg
    },
    {
        key: 'dewpt',
        label: 'Dew point',
        unit: 'ºC',
        colour: '#2f8f46',
        group: 'temp',
        on: true,
        read: row => row.uk_hybrid?.dewptAvg
    },
    {
        key: 'windSpeed',
        floor: 0,
        label: 'Wind speed',
        unit: 'km/h',
        colour: '#1668b0',
        group: 'wind',
        on: true,
        read: row => row.uk_hybrid?.windspeedAvg
    },
    {
        key: 'windGust',
        floor: 0,
        label: 'Wind gust',
        unit: 'km/h',
        colour: '#e07b1f',
        group: 'wind',
        on: true,
        // Each gust is a moment, not a trend: joining them into a line would
        // draw a wind that rose and fell smoothly between peaks it never held.
        shape: 'dots',
        // The peak within the bucket: an average gust is not a gust.
        read: row => row.uk_hybrid?.windgustHigh
    },
    {
        key: 'windDir',
        label: 'Wind direction',
        unit: 'º',
        // Slate rather than another blue: wind speed is already blue, and in
        // the overlay the two were near enough to be taken for one line.
        colour: '#4b5563',
        group: 'direction',
        on: true,
        // A compass wraps, so 359º to 1º is one degree of change and a line
        // through it would draw a full-height fall that never happened.
        shape: 'dots',
        // Fixed to the whole compass: an auto-fitted axis makes a steady wind
        // look like it is swinging wildly.
        domain: [0, 360],
        read: row => row.winddirAvg
    },
    {
        key: 'humidity',
        floor: 0,
        label: 'Humidity',
        unit: '%',
        colour: '#0f8f8f',
        group: 'humidity',
        read: row => row.humidityAvg
    },
    {
        key: 'pressure',
        label: 'Pressure',
        unit: 'kPa',
        colour: '#7a4fbf',
        group: 'pressure',
        digits: 1,
        read: row => (row.uk_hybrid?.pressureMax ?? null) === null
            ? null
            : row.uk_hybrid.pressureMax / 10
    },
    {
        key: 'solar',
        floor: 0,
        label: 'Solar radiation',
        unit: 'W/m²',
        colour: '#e0a81f',
        group: 'solar',
        on: true,
        digits: 0,
        read: row => row.solarRadiationHigh
    },
    {
        key: 'uv',
        floor: 0,
        label: 'UV index',
        unit: '',
        colour: '#8f2f8f',
        group: 'uv',
        on: true,
        digits: 1,
        read: row => row.uvHigh
    },
    {
        key: 'precipRate',
        floor: 0,
        label: 'Rain rate',
        unit: 'mm/hr',
        colour: '#7ac043',
        group: 'precip',
        on: true,
        digits: 2,
        read: row => row.uk_hybrid?.precipRate
    },
    {
        key: 'precipTotal',
        floor: 0,
        label: 'Rain today',
        unit: 'mm',
        colour: '#2f9fd0',
        group: 'precip',
        on: true,
        digits: 2,
        read: row => row.uk_hybrid?.precipTotal
    }
];

/**
 * Turns anything non-numeric into a gap rather than a zero, so a station that
 * reports nothing draws no line instead of a flat one along the floor.
 * @param {*} value - A raw reading
 * @returns {?number} The number, or null
 */
function numeric(value) {
    return value === null || value === undefined || Number.isNaN(Number(value))
        ? null
        : Number(value);
}

export class History {
    /**
     * Today's readings for one station, from cache when it is fresh enough.
     * @param {string} stationId - The Weather Underground station id
     * @returns {Promise<?Object>} times, values and the day's bounds, or null
     */
    async load(stationId) {
        const cacheKey = `weather_history_${stationId}`;

        try {
            const cached = JSON.parse(localStorage.getItem(cacheKey));
            const age = (Date.now() - (cached?.fetchedAt ?? 0)) / 1000;

            if (cached?.day && age < HISTORY_CACHE_SECONDS) {
                return cached.day;
            }
        } catch (error) {
            // A corrupt or unreadable entry is not worth failing the chart for.
        }

        const day = await this.fetchDay(stationId);
        if (!day) return null;

        try {
            localStorage.setItem(cacheKey, JSON.stringify({fetchedAt: Date.now(), day}));
        } catch (error) {
            console.error(`Could not cache the day for ${stationId}:`, error);
        }

        return day;
    }

    /**
     * Reads a station's day and trims it to the charted measurements.
     * @param {string} stationId - The Weather Underground station id
     * @returns {Promise<?Object>} times, values, dayStart and dayEnd
     */
    async fetchDay(stationId) {
        const url = `${HISTORY_URL}?stationId=${stationId}&format=json&units=h`
            + `&numericPrecision=decimal&apiKey=${WU_API_KEY}`;

        let rows;

        try {
            const response = await fetch(url);

            // A station with nothing logged yet answers 204, which is an empty
            // day rather than a failure.
            if (response.status === 204) return null;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            rows = (await response.json())?.observations;
        } catch (error) {
            console.error(`Could not read the day for ${stationId}:`, error);
            return null;
        }

        if (!rows?.length) return null;

        const times = rows.map(row => row.epoch * 1000);
        const values = {};

        for (const series of SERIES) {
            const column = rows.map(row => numeric(series.read(row)));
            // Drop a measurement the station never reports, so its chip does
            // not offer an empty line.
            if (column.some(value => value !== null)) values[series.key] = column;
        }

        return {times, values, ...this.dayBounds(rows[0])};
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
