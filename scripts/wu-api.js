/**
 * Weather Underground's personal weather station API.
 *
 * Two endpoints are used: the current observation behind the tiles, and the
 * day's five-minute buckets behind the charts. They take the same key, the same
 * units and the same station id, and they were being assembled separately in
 * two files — which is exactly how a units change ends up applied to the tiles
 * and not to the chart under them.
 *
 * Errors are thrown rather than swallowed. Each caller has its own answer to a
 * station that will not answer — the tiles fall back to cached readings, the
 * chart draws nothing — and that decision does not belong down here.
 */

// The public key published with the station data. Not a secret: it is visible
// in every request the page makes.
const API_KEY = '6dfb9fed05d24b71bb9fed05d20b715d';

const BASE_URL = 'https://api.weather.com/v2/pws';

// Metric-with-UK-hybrid units, and full precision rather than the rounded
// integers the API gives by default.
const FORMAT = 'format=json&units=h&numericPrecision=decimal';

export class WeatherUndergroundApi {
    /**
     * The URL for one endpoint and station.
     * @param {string} path - The endpoint path, below the API root
     * @param {string} stationId - The station id
     * @returns {string} The full request URL
     */
    url(path, stationId) {
        return `${BASE_URL}/${path}?stationId=${stationId}&${FORMAT}&apiKey=${API_KEY}`;
    }

    /**
     * Reads an endpoint.
     * @param {string} path - The endpoint path
     * @param {string} stationId - The station id
     * @returns {Promise<?Object>} The parsed response, or null when there is nothing to report
     * @throws {Error} When the station answers with a failure
     */
    async read(path, stationId) {
        const response = await fetch(this.url(path, stationId));

        // A station with nothing logged yet answers 204, which is an empty
        // reading rather than a failure.
        if (response.status === 204) return null;
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        return response.json();
    }

    /**
     * A station's latest observation.
     * @param {string} stationId - The station id
     * @returns {Promise<?Object>} The response, with its single observation
     */
    current(stationId) {
        return this.read('observations/current', stationId);
    }

    /**
     * A station's day so far, in five-minute buckets.
     * @param {string} stationId - The station id
     * @returns {Promise<?Object>} The response, with one observation per bucket
     */
    day(stationId) {
        return this.read('observations/all/1day', stationId);
    }
}

const api = new WeatherUndergroundApi();
export default api;
