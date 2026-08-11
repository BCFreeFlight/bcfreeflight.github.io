/**
 * The forecast sounding, from the model the Canadian RASP itself runs on.
 *
 * The RASP builds its windgrams server-side: it pulls GRIB2 files from
 * Environment Canada, cuts them into tiles, and renders a PNG per site per run.
 * None of that is available to a browser — GRIB2 is a binary format served
 * without cross-origin headers — so this asks Open-Meteo for the same model's
 * output instead, and the drawing is done here.
 *
 * It really is the same air. HRDPS publishes on fixed pressure levels, and the
 * heights those levels sit at come back within a few metres of the ones printed
 * up the side of a RASP windgram for the same hour. What changes is the ground
 * underneath them: the RASP takes the terrain height of its own 2.5 km grid
 * cell, which in a valley this steep is some hundreds of metres below the
 * launch it is drawing, while Open-Meteo reports the elevation of the point that
 * was actually asked for. The launch's own terrain is the more useful of the
 * two, and it is why nothing here rounds the coordinates: a hundredth of a
 * degree is a couple of hundred metres of hillside around Cooper's, and moving
 * the request that far moves the ground under the whole drawing.
 *
 * Two requests, because they come from two different models — the same split,
 * and for the same reason, as `sounding-api.js`.
 */

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

// Environment Canada's 2.5 km model, named rather than blended so the forecast
// and the RASP it is meant to be read beside come from the same place.
const FORECAST_MODEL = 'gem_hrdps_continental';

/**
 * The pressure levels the forecast profile is read at.
 *
 * The RASP's own list, less the three that sit below any ground worth drawing
 * and the one above the ceiling. The close spacing low down is the point: the
 * top of the convective layer is usually within a few hundred metres of the
 * ground in the morning, and a level every 25 hPa is what resolves it.
 *
 * @type {number[]}
 */
export const FORECAST_LEVELS = [1000, 950, 925, 900, 875, 850, 800, 750, 700, 650, 600];

/**
 * What is read at every level.
 *
 * Height because a pressure level is not a fixed altitude; temperature for the
 * stability bands and the parcel; humidity because the model publishes that
 * rather than the dew point depression the RASP reads out of its GRIB files, so
 * the depression is worked out here; wind for the barbs.
 *
 * @type {string[]}
 */
const PER_LEVEL = [
    'temperature',
    'relative_humidity',
    'wind_speed',
    'wind_direction',
    'geopotential_height'
];

/** What is read at the ground, including the RASP's own bottom row of barbs. */
const SURFACE = [
    'temperature_2m',
    'dew_point_2m',
    'wind_speed_10m',
    'wind_direction_10m',
    'surface_pressure',
    'pressure_msl',
    'cloud_cover',
    'precipitation'
];

/**
 * Two days, on the site's own clock.
 *
 * `timezone=auto` is what makes the window line up with a flying day rather
 * than with UTC, and it is also how the offset needed to label the hours comes
 * back. Times themselves stay as epoch seconds.
 */
const WINDOW = 'forecast_days=2&timezone=auto&timeformat=unixtime';

export class RaspApi {
    /**
     * The URL for the forecast profile above one point.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {string} The full request URL
     */
    profileUrl(latitude, longitude) {
        const fields = [
            ...FORECAST_LEVELS.flatMap(level => PER_LEVEL.map(field => `${field}_${level}hPa`)),
            ...SURFACE
        ].join(',');

        return `${BASE_URL}?latitude=${latitude}&longitude=${longitude}`
            + `&models=${FORECAST_MODEL}&hourly=${fields}&${WINDOW}`;
    }

    /**
     * The URL for the surface energy balance above one point.
     *
     * Deliberately unmodelled: HRDPS does not publish its heat fluxes here, so
     * this takes Open-Meteo's blended pick. The fluxes are what set the strength
     * of the day, and a blended answer to that question is worth far more than
     * no answer at all.
     *
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {string} The full request URL
     */
    fluxUrl(latitude, longitude) {
        return `${BASE_URL}?latitude=${latitude}&longitude=${longitude}`
            + `&hourly=sensible_heat_flux,latent_heat_flux&${WINDOW}`;
    }

    /**
     * Reads one URL.
     * @param {string} url - The request URL
     * @returns {Promise<Object>} The parsed response
     * @throws {Error} When the service answers with a failure
     */
    async read(url) {
        const response = await fetch(url);

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        return response.json();
    }

    /**
     * Both halves at once, either of which may come back empty.
     *
     * A profile with no fluxes still draws the stability, the wind and the
     * cloudbase — everything but the climb rate. Fluxes with no profile draw
     * nothing, but there is no reason to fail the one for the other.
     *
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<Object[]>} The profile response and the flux response
     */
    readBoth(latitude, longitude) {
        return Promise.all([
            this.read(this.profileUrl(latitude, longitude)).catch(error => {
                console.error('Could not read the forecast profile:', error);
                return null;
            }),
            this.read(this.fluxUrl(latitude, longitude)).catch(error => {
                console.error('Could not read the forecast surface energy balance:', error);
                return null;
            })
        ]);
    }
}

const api = new RaspApi();
export default api;
