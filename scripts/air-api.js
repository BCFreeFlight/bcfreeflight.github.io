/**
 * Open-Meteo's air quality API.
 *
 * One endpoint, no key, and no account: the service is free for non-commercial
 * use and answers browsers directly, which is what makes it usable from a site
 * with no server to keep a secret on. The readings come from the Copernicus
 * Atmosphere Monitoring Service, whose forecasts are what the numbers actually
 * are — a model of the air over a grid square, not a sensor on a roof. Anything
 * that reports them should say so.
 *
 * Errors are thrown rather than swallowed, the same way the station API does it,
 * because what to do about a missing reading belongs to the page and not here.
 */

const BASE_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// What the site reads. `us_aqi` is the single number people recognise from
// every air quality map; pm2.5 is the measurement underneath it, and the one
// that matters in smoke.
const MEASUREMENTS = 'us_aqi,pm2_5';

// Yesterday through tomorrow, which is more than today needs and is the point:
// the response is in UTC, the day being charted is local, and a day that starts
// at 07:00 UTC would otherwise run off the end of the forecast by evening.
const WINDOW = 'past_days=1&forecast_days=2';

// The model is published on a tenth of a degree, and the API snaps to it: ask
// about two points in the same square and the same square answers. Rounding to
// the grid before asking makes that visible rather than accidental, and means
// two stations on the same hillside share one request instead of making two
// that return the same numbers.
const GRID = 10;

/**
 * A coordinate on the model's own grid.
 * @param {number} degrees - Latitude or longitude
 * @returns {number} The same, snapped to a tenth of a degree
 */
export function onGrid(degrees) {
    return Math.round(degrees * GRID) / GRID;
}

export class AirQualityApi {
    /**
     * The URL for one point.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {string} The full request URL
     */
    url(latitude, longitude) {
        return `${BASE_URL}?latitude=${onGrid(latitude)}&longitude=${onGrid(longitude)}`
            + `&hourly=${MEASUREMENTS}&current=${MEASUREMENTS}&${WINDOW}`
            // Epoch seconds rather than wall-clock strings, so nothing here has
            // to know what a timezone is: the chart plots milliseconds and these
            // convert with a multiplication.
            + '&timeformat=unixtime';
    }

    /**
     * Reads the air over one point.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<Object>} The parsed response
     * @throws {Error} When the service answers with a failure
     */
    async read(latitude, longitude) {
        const response = await fetch(this.url(latitude, longitude));

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        return response.json();
    }
}

const api = new AirQualityApi();
export default api;
