import {onGrid} from './air-api.js';

/**
 * The air above the stations, and the heat going into it.
 *
 * Everything the windgram can measure, it measures. Two things it cannot:
 *
 * The first is the air above the highest station. Silver Star tops out at
 * 5,453 ft, and on a normal summer day the thermals stop a couple of thousand
 * feet above that — so the part of the column that decides where a climb ends
 * is air nothing on the hillside is standing in. That used to be answered by
 * continuing the gradient between the top two stations, which is a guess that
 * gets worse the further it goes.
 *
 * The second is the surface heat flux. How much of the sunlight landing on the
 * ground comes back as heat in the air, rather than evaporating water, is what
 * sets the strength of the day — and measuring it takes an eddy covariance rig,
 * not a weather station. It was a constant.
 *
 * Both come from Open-Meteo, and from two different models on purpose:
 *
 * The sounding and the cloud come from HRDPS, which is Environment Canada's
 * 2.5 km model and the one the Canadian RASP itself runs on. Resolution is the
 * whole game in mountain terrain, and a chart meant to be read beside that one
 * should be looking at the same air.
 *
 * The heat fluxes come from Open-Meteo's blended pick, because HRDPS does not
 * publish them here. Only the *ratio* is taken from it — the sunlight itself is
 * always the pyranometer at launch, which knows about today's smoke.
 *
 * Nothing here asks for a forecast. The window ends at the current hour.
 */

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

// Environment Canada's 2.5 km model, the same one the Canadian RASP is built
// on. Named rather than blended, so the profile and the drawing it is compared
// against come from the same place.
const SOUNDING_MODEL = 'gem_hrdps_continental';

/**
 * The pressure levels the profile is read at.
 *
 * Enough to cover from a valley floor to well above the ceiling of the drawing.
 * Each is asked for twice — its temperature, and the height it happens to be at
 * this hour, since a pressure level is not a fixed altitude.
 *
 * Spaced 25 hPa apart low down, which is the RASP's own spacing and is what puts
 * a level inside each gap between the stations: they stand five and six hundred
 * metres apart, and a morning inversion is a fraction of that deep.
 *
 * @type {number[]}
 */
export const LEVELS = [1000, 950, 925, 900, 875, 850, 800, 750, 700, 650, 600];

// A whole day behind, and no further forward than the hour we are in. The
// windgram never draws the future, so nothing here asks for one: `past_hours`
// with a single forecast hour gives a window that ends now.
const WINDOW = 'past_hours=24&forecast_hours=1&timeformat=unixtime';

export class SoundingApi {
    /**
     * The URL for the profile and cloud above one point.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {string} The full request URL
     */
    profileUrl(latitude, longitude) {
        const fields = [
            ...LEVELS.map(level => `temperature_${level}hPa`),
            ...LEVELS.map(level => `geopotential_height_${level}hPa`),
            'cloud_cover'
        ].join(',');

        return `${BASE_URL}?latitude=${onGrid(latitude)}&longitude=${onGrid(longitude)}`
            + `&models=${SOUNDING_MODEL}&hourly=${fields}&${WINDOW}`;
    }

    /**
     * The URL for the surface energy balance above one point.
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {string} The full request URL
     */
    surfaceUrl(latitude, longitude) {
        return `${BASE_URL}?latitude=${onGrid(latitude)}&longitude=${onGrid(longitude)}`
            + `&hourly=sensible_heat_flux,latent_heat_flux,shortwave_radiation&${WINDOW}`;
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
     * Both halves at once. They are separate requests because they come from
     * separate models, and either is worth having without the other: a profile
     * with no flux still fixes the top of the column, and a flux with no profile
     * still fixes the strength of the day.
     *
     * @param {number} latitude - Degrees north
     * @param {number} longitude - Degrees east
     * @returns {Promise<Object[]>} The profile response and the surface response
     */
    readBoth(latitude, longitude) {
        return Promise.all([
            this.read(this.profileUrl(latitude, longitude)).catch(error => {
                console.error('Could not read the profile aloft:', error);
                return null;
            }),
            this.read(this.surfaceUrl(latitude, longitude)).catch(error => {
                console.error('Could not read the surface energy balance:', error);
                return null;
            })
        ]);
    }
}

const api = new SoundingApi();
export default api;
