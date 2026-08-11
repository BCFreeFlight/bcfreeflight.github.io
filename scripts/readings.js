import weather from './weather.js';
import {pointAt} from './config/compass.js';
import {facingLaunch} from './lib/launch.js';
import {fixed, isNumber} from './lib/numbers.js';
import {pairByElevation} from './lib/lapse.js';

/**
 * Shared presentation of station readings.
 *
 * Both the weather page and the live overlay show the same measurements in
 * different shapes. Each reading is turned into its parts and its wording once,
 * here, so the two pages cannot drift apart in rounding, units, or compass
 * precision. Rendering stays with each page; only the numbers and words live here.
 */

// Shown wherever a station reports nothing for a field.
export const NO_READING = '—';

/**
 * Formats a measurement, or reports its absence.
 * @param {?number} value - The raw reading
 * @param {number} [digits=1] - Decimal places
 * @returns {string} The fixed-point value, or NO_READING
 */
export function format(value, digits = 1) {
    return fixed(value, digits, NO_READING);
}

/**
 * Wind direction and strength.
 *
 * `cardinal` is the 16-point compass name of the direction the wind blows
 * *from*, so NNW stays NNW rather than collapsing to N. `rotation` is where an
 * arrow should point: 180 degrees off the cardinal, because the air travels
 * away from the direction it is named for.
 *
 * `onLaunch` answers whether that direction is one the hill can be flown in,
 * and only a station that stands at a launch can answer it at all. Everywhere
 * else it is null, which is not the same as false: the valley station is not
 * reporting an unflyable wind, it is reporting a wind about a place nobody
 * launches from.
 *
 * @param {?Object} observation - A station observation
 * @param {?Object} [launch] - The station's launch window, when it has one
 * @returns {Object} cardinal, bearing, rotation, onLaunch, speed, gust, summaries
 */
export function wind(observation, launch = null) {
    const uk = observation?.uk_hybrid ?? {};
    const degrees = observation?.winddir;
    const known = isNumber(degrees);
    const point = known ? pointAt(degrees) : null;

    const speed = format(uk.windSpeed);
    const gust = format(uk.windGust);
    const gusting = gust !== NO_READING && speed !== NO_READING && Number(gust) > Number(speed);

    return {
        cardinal: point?.abbr ?? NO_READING,
        cardinalWords: point?.words ?? null,
        bearing: known ? Math.round(degrees) : null,
        rotation: known ? degrees + 180 : 0,
        onLaunch: facingLaunch(known ? Number(degrees) : null, launch),
        speed,
        gust,
        gusting,
        summary: `${point?.abbr ?? NO_READING} ${speed} km/h`,
        // The same wording the weather page uses under its wind figure. When
        // there is nothing gusting there is nothing to report, so the line goes
        // back to naming the reading above it.
        gustSummary: gusting ? `Gusting to ${gust} km/h` : 'Wind'
    };
}

/**
 * Temperature at the station.
 * @param {?Object} observation - A station observation
 * @returns {Object} celsius and its wording
 */
export function temperature(observation) {
    const celsius = format(observation?.uk_hybrid?.temp);
    return {celsius, summary: `${celsius} ºC`};
}

/**
 * Rain accumulated so far today.
 * @param {?Object} observation - A station observation
 * @returns {Object} millimetres and its wording
 */
export function rainfall(observation) {
    const millimetres = format(observation?.uk_hybrid?.precipTotal, 2);
    return {millimetres, summary: `${millimetres} mm`};
}

/**
 * Current rate of rain.
 * @param {?Object} observation - A station observation
 * @returns {Object} millimetres per hour and its wording
 */
export function precipitationRate(observation) {
    const rate = format(observation?.uk_hybrid?.precipRate, 2);
    return {rate, summary: `${rate} mm/hr`};
}

/**
 * Lapse rate for each adjacent pair of stations, highest first.
 *
 * A station that is offline drops out and its neighbours pair up, so two live
 * stations still give one segment.
 *
 * @param {Object[]} loaded - Station entries from Weather.loadStations
 * @returns {Object[]} One segment per adjacent pair, each with its own wording
 */
export function lapseSegments(loaded) {
    const reporting = loaded.filter(entry =>
        entry.online && entry.observation?.uk_hybrid?.elev !== undefined);

    return pairByElevation(reporting, entry => entry.observation.uk_hybrid.elev)
        .map(({upper, lower}) => ({
            ...lapse(weather.calculateLapseRate(upper.observation, lower.observation)),
            // Short names here: a segment names two stations at once, and the
            // full pair would crowd both the tab bar and the video overlay.
            from: upper.station.shortName,
            to: lower.station.shortName,
            span: `${upper.station.shortName} → ${lower.station.shortName}`
        }));
}

/**
 * Lapse rate between two stations. Needs both, so it carries its own
 * unavailable state rather than throwing on a missing half.
 * @param {?Object} lapseRateInfo - Lapse rate info from the weather service
 * @returns {Object} available, rate, elevDiff, name, description and wordings
 */
export function lapse(lapseRateInfo) {
    const available = Boolean(lapseRateInfo) && lapseRateInfo.lapseRate !== null;

    if (!available) {
        return {
            available: false,
            rate: null,
            elevDiff: null,
            name: null,
            description: null,
            colour: null,
            summary: NO_READING,
            title: 'Lapse Rate'
        };
    }

    const elevDiff = Math.round(Number(lapseRateInfo.elevDiff));

    return {
        available: true,
        rate: Number(lapseRateInfo.lapseRate),
        elevDiff,
        name: lapseRateInfo.details.name,
        description: lapseRateInfo.details.description,
        colour: lapseRateInfo.details.color,
        summary: `${lapseRateInfo.lapseRate} ºC/1000 ft`,
        title: `Lapse Rate: (${elevDiff.toLocaleString()} ft)`
    };
}
