/**
 * Wind barbs.
 *
 * The barb is the oldest thing on a weather chart and it is still the best: it
 * puts a direction and a speed in one mark, small enough to tile across a
 * drawing, and readable without a legend once you know that a half feather is
 * five and a full feather is ten.
 *
 * The shaft lies along the wind's axis with the feathers at the upwind end, so
 * a wind blowing from the east to the west draws a line east to west with its
 * feathers on the east. Speed is rounded to the nearest five before it is
 * drawn, because that is the resolution the notation has: there is no mark for
 * seven.
 *
 * Two departures from the textbook version, both deliberate:
 *
 * A bare shaft means calm. Elsewhere a shaft with no feathers is a light wind
 * and a ring is a calm, but the readings here are averaged over half an hour
 * and the numbers pilots read off this hill are small, so the simpler rule
 * carries better: no feather, no wind.
 *
 * There is no pennant. A pennant is worth fifty, and a fifty kilometre wind on
 * launch is not a day anybody is flying — the detail would be paid for in
 * clutter across every readable day. Three feathers is the top of the scale and
 * means thirty or more.
 *
 * Everything here is produced in a local frame with the plotted point at the
 * origin and the shaft running straight up, and is turned into place by the
 * caller. Rotating a finished mark is one transform; rotating every coordinate
 * of it by hand is a dozen chances to get a sign wrong.
 */

// Speeds in km/h, matching the units the stations report and the units the
// footer of the drawing declares.
const FEATHER = 10;
const HALF = 5;

/** The top of the scale: three feathers, and no mark for anything beyond. */
export const MAXIMUM = 30;

const SHAFT = 21;
const FEATHER_LENGTH = 9;
const FEATHER_STEP = 4.2;

// How far a feather leans back toward the point. Upright feathers read as a
// ladder; this is the lean every printed chart uses.
const LEAN = 2.5;

/**
 * The marks a speed is drawn with.
 *
 * Nothing at all for a calm, then a half feather per five up to three full
 * feathers, which is where the scale stops.
 *
 * @param {number} speed - Wind speed, in km/h
 * @returns {Object} How many feathers and half feathers
 */
export function barbCounts(speed) {
    // Standard rounding to the nearest five, then held at the top of the scale.
    const rounded = Math.min(Math.round(speed / HALF) * HALF, MAXIMUM);

    if (!(rounded > 0)) return {feathers: 0, halves: 0};

    return {
        feathers: Math.floor(rounded / FEATHER),
        halves: rounded % FEATHER >= HALF ? 1 : 0
    };
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
 * @returns {string} SVG path data: always at least a shaft
 */
export function barbPath(speed) {
    const {feathers, halves} = barbCounts(speed);

    // The shaft is drawn whatever the speed. On its own it is the mark for a
    // calm, and every feather hangs off it.
    let path = `M0 0L0 -${SHAFT}`;

    // Laid out from the tail down toward the point, full feathers first, which
    // is the order the notation is read in.
    let offset = SHAFT;

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
