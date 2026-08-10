/**
 * Wind barbs.
 *
 * The barb is the oldest thing on a weather chart and it is still the best: it
 * puts a direction and a speed in one mark, small enough to tile across a
 * drawing, and readable without a legend once you know that a half feather is
 * five, a full feather is ten and a pennant is fifty.
 *
 * The shaft lies along the wind's axis with the feathers at the upwind end, so
 * a wind blowing from the east to the west draws a line east to west with its
 * feathers on the east. Speed is rounded to the nearest five before it is
 * drawn, because that is the resolution the notation has: there is no mark for
 * seven.
 *
 * Everything here is produced in a local frame with the plotted point at the
 * origin and the shaft running straight up, and is turned into place by the
 * caller. Rotating a finished mark is one transform; rotating every coordinate
 * of it by hand is a dozen chances to get a sign wrong.
 */

// Speeds in km/h, matching the units the stations report and the units the
// footer of the drawing declares.
const PENNANT = 50;
const FEATHER = 10;
const HALF = 5;

// Under this the direction is not meaningful and the notation says so with a
// ring rather than a bare shaft, which would otherwise read as a five.
export const CALM = 2.5;

const SHAFT = 21;
const FEATHER_LENGTH = 9;
const FEATHER_STEP = 4.2;

// How far a feather leans back toward the point. Upright feathers read as a
// ladder; this is the lean every printed chart uses.
const LEAN = 2.5;

/**
 * The marks a speed is drawn with.
 * @param {number} speed - Wind speed, in km/h
 * @returns {Object} How many pennants, feathers and half feathers
 */
export function barbCounts(speed) {
    let remaining = Math.round(speed / HALF) * HALF;

    const pennants = Math.floor(remaining / PENNANT);
    remaining -= pennants * PENNANT;

    const feathers = Math.floor(remaining / FEATHER);
    remaining -= feathers * FEATHER;

    return {pennants, feathers, halves: remaining >= HALF ? 1 : 0};
}

/**
 * One barb, drawn upright, with the plotted point at the origin.
 *
 * The caller rotates it to the wind's bearing: because the shaft points up and
 * a bearing is measured clockwise from north, the rotation is the bearing
 * itself, with no correction. This is the one place on the site where a wind
 * direction is *not* turned 180 degrees — an arrow has to point somewhere, but
 * a barb is a line, and the feathers are what say which end is upwind.
 *
 * @param {number} speed - Wind speed, in km/h
 * @returns {string} SVG path data, or an empty string for a calm
 */
export function barbPath(speed) {
    if (!(speed >= CALM)) return '';

    const {pennants, feathers, halves} = barbCounts(speed);

    // A wind that rounds to nothing but is not quite calm still gets a shaft,
    // so it is visible as a direction with a speed too low to mark.
    let path = `M0 0L0 -${SHAFT}`;

    // Laid out from the tail down toward the point, heaviest mark first, which
    // is the order the notation is read in.
    let offset = SHAFT;

    for (let i = 0; i < pennants; i++) {
        // A solid triangle standing on the shaft. It eats two slots of shaft,
        // because a pennant crowded against a feather cannot be told from two
        // feathers.
        path += `M0 -${offset.toFixed(1)}`
            + `L${FEATHER_LENGTH} -${(offset - LEAN).toFixed(1)}`
            + `L0 -${(offset - FEATHER_STEP).toFixed(1)}Z`;
        offset -= FEATHER_STEP * 1.6;
    }

    // A pennant sitting directly against the first feather reads as one mark,
    // so the two are given a gap between them.
    if (pennants && (feathers || halves)) offset -= FEATHER_STEP * 0.5;

    for (let i = 0; i < feathers; i++) {
        path += `M0 -${offset.toFixed(1)}L${FEATHER_LENGTH} -${(offset + LEAN).toFixed(1)}`;
        offset -= FEATHER_STEP;
    }

    if (halves) {
        // Never at the very tail: a half feather in the end slot is easily read
        // as a full one, so it is stepped in when it would land there.
        if (offset === SHAFT) offset -= FEATHER_STEP;

        path += `M0 -${offset.toFixed(1)}L${(FEATHER_LENGTH / 2).toFixed(1)} -${(offset + LEAN / 2).toFixed(1)}`;
    }

    return path;
}
