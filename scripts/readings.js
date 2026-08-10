import weather from './weather.js';

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

// Compass points written out. "SSW" is jargon; "south-southwest" is not, and
// the page has to read for someone who has never seen a wind report.
const COMPASS_WORDS = {
    N: 'north',
    NNE: 'north-northeast',
    NE: 'northeast',
    ENE: 'east-northeast',
    E: 'east',
    ESE: 'east-southeast',
    SE: 'southeast',
    SSE: 'south-southeast',
    S: 'south',
    SSW: 'south-southwest',
    SW: 'southwest',
    WSW: 'west-southwest',
    W: 'west',
    WNW: 'west-northwest',
    NW: 'northwest',
    NNW: 'north-northwest'
};

/**
 * Formats a measurement, or reports its absence.
 * @param {?number} value - The raw reading
 * @param {number} [digits=1] - Decimal places
 * @returns {string} The fixed-point value, or NO_READING
 */
export function format(value, digits = 1) {
    return value === null || value === undefined || Number.isNaN(Number(value))
        ? NO_READING
        : Number(value).toFixed(digits);
}

/**
 * Wind direction and strength.
 *
 * `cardinal` is the 16-point compass name of the direction the wind blows
 * *from*, so NNW stays NNW rather than collapsing to N. `rotation` is where an
 * arrow or a windsock tail should point: 180 degrees off the cardinal, because
 * the air travels away from the direction it is named for.
 *
 * @param {?Object} observation - A station observation
 * @returns {Object} cardinal, bearing, rotation, speed, gust, summary, gustSummary
 */
export function wind(observation) {
    const uk = observation?.uk_hybrid ?? {};
    const degrees = observation?.winddir;
    const known = degrees !== null && degrees !== undefined;

    const cardinal = known ? weather.degreesToDirection(degrees) : NO_READING;
    const speed = format(uk.windSpeed);
    const gust = format(uk.windGust);
    const gusting = gust !== NO_READING && speed !== NO_READING && Number(gust) > Number(speed);

    return {
        cardinal,
        cardinalWords: known ? COMPASS_WORDS[cardinal] ?? cardinal : null,
        bearing: known ? Math.round(degrees) : null,
        rotation: known ? degrees + 180 : 0,
        speed,
        gust,
        gusting,
        summary: `${cardinal} ${speed} km/h`,
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
 * Stations are ordered by the elevation they report rather than by their place
 * in the configuration, so the segments always read downhill: Silver Star to
 * Launch, then Launch to the Landing Zone. A station that is offline drops out
 * and its neighbours pair up, so two live stations still give one segment.
 *
 * @param {Object[]} loaded - Station entries from Weather.loadStations
 * @returns {Object[]} One segment per adjacent pair, each with its own wording
 */
export function lapseSegments(loaded) {
    const ranked = loaded
        .filter(entry => entry.online && entry.observation?.uk_hybrid?.elev !== undefined)
        .sort((a, b) => b.observation.uk_hybrid.elev - a.observation.uk_hybrid.elev);

    const segments = [];

    for (let i = 0; i < ranked.length - 1; i++) {
        const upper = ranked[i];
        const lower = ranked[i + 1];
        const reading = lapse(weather.calculateLapseRate(upper.observation, lower.observation));

        // Short names here: a segment names two stations at once, and the full
        // pair would crowd both the tab bar and the video overlay.
        segments.push({
            ...reading,
            from: upper.station.shortName,
            to: lower.station.shortName,
            span: `${upper.station.shortName} → ${lower.station.shortName}`
        });
    }

    return segments;
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
