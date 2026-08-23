/**
 * Weather Underground's personal weather station API.
 *
 * One endpoint is used: the day's five-minute buckets, which are both the chart
 * and — in their newest bucket — every reading above it. There was a second,
 * the current observation, until the readings moved onto the day; one request
 * per station now serves both, and the two can no longer disagree.
 *
 * Errors are thrown rather than swallowed. Each caller has its own answer to a
 * station that will not answer — the readings fall back to a cached day, the
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
