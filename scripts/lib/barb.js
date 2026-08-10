/**
 * Wind barbs.
 *
 * The barb is the oldest thing on a weather chart and it is still the best: it
 * puts a direction and a speed in one mark, small enough to tile across a
 * drawing, and readable without a legend once you know that a half feather is
 * five and a full feather is ten.
 *
 * The scale this site reads them on, in km/h:
 *
 *     0   a double circle, and no staff at all — a calm has no direction
 *     5   one half feather, at the very tip
 *    10   one full feather
 *    15   a full feather, with a half below it
 *    20   two full feathers
 *    25   two full feathers, with a half below them
 *    30+  three full feathers
 *    90+  a solid pennant, in place of the feathers
 *
 * Speed is rounded to the nearest five before any of that is decided, because
 * that is the resolution the notation has: there is no mark for seven.
 *
 * The staff lies along the wind's axis with the feathers at the upwind end, so
 * a wind blowing from the east to the west draws a line east to west with its
 * feathers on the east.
 *
 * Everything here is produced in a local frame with the plotted point at the
 * origin and the staff running straight up, and is turned into place by the
 * caller. Rotating a finished mark is one transform; rotating every coordinate
 * of it by hand is a dozen chances to get a sign wrong.
 */

// Speeds in km/h, matching the units the stations report and the units the
// footer of the drawing declares.
const FEATHER = 10;
const HALF = 5;

/** Where the feathers give way to a pennant. */
export const PENNANT = 90;

/** The most feathers drawn: three, which is the mark for thirty or more. */
export const MAXIMUM_FEATHERS = 3;

const STAFF = 25;
const FEATHER_LENGTH = 11;
const FEATHER_STEP = 4.8;

/**
 * How far the staff carries on past the outermost feather.
 *
 * The one measurement here doing real work. With the feathers starting exactly
 * at the tip, a single full feather joined the end of the staff at a corner and
 * the two read as one bent line — a ten kilometre wind came out as an "L"
 * rather than as a staff with a feather on it. Two or more feathers were never
 * ambiguous, which is why only the commonest barb on the chart looked wrong. A
 * few pixels of staff past the last feather makes every mark read the same way:
 * a line, with ticks counted off its tail.
 */
const OVERHANG = 5;

/**
 * The angle a feather stands off the staff, measured from the staff's outward
 * direction, so the interior angle between the two is 120º. Square to the staff
 * reads as a ladder; this is the rake printed charts use.
 */
const FEATHER_ANGLE = 60;

const RADIANS = Math.PI / 180;
const ACROSS = Math.sin(FEATHER_ANGLE * RADIANS);
const ALONG = Math.cos(FEATHER_ANGLE * RADIANS);

/**
 * The rings that mark a calm, as radii from the plotted point.
 *
 * A calm is the one reading with no direction in it, so it is the one mark with
 * no staff: an averaged direction under a still anemometer is the arithmetic of
 * noise, and pointing a line along it would dress that up as information.
 *
 * @type {number[]}
 */
export const CALM_RINGS = [2.2, 4.6];

/**
 * The marks a speed is drawn with.
 * @param {number} speed - Wind speed, in km/h
 * @returns {Object} Whether it is calm, and how many pennants, feathers and halves
 */
export function barbCounts(speed) {
    // Standard rounding to the nearest five, before anything else is decided.
    const rounded = Math.round(speed / HALF) * HALF;

    if (!(rounded > 0)) return {calm: true, pennants: 0, feathers: 0, halves: 0};
    if (rounded >= PENNANT) return {calm: false, pennants: 1, feathers: 0, halves: 0};

    const feathers = Math.min(Math.floor(rounded / FEATHER), MAXIMUM_FEATHERS);

    return {
        calm: false,
        pennants: 0,
        feathers,
        // Three feathers is the top of the feather scale and means thirty or
        // more, so nothing is hung below it.
        halves: feathers < MAXIMUM_FEATHERS && rounded % FEATHER >= HALF ? 1 : 0
    };
}

/**
 * One mark on the staff, standing outward at the feather angle.
 * @param {number} offset - How far up the staff it starts
 * @param {number} length - How long the mark is
 * @returns {string} A path segment
 */
function feather(offset, length) {
    return `M0 -${offset.toFixed(1)}`
        + `L${(length * ACROSS).toFixed(1)} -${(offset + length * ALONG).toFixed(1)}`;
}

/**
 * One barb, drawn upright, with the plotted point at the origin.
 *
 * The caller rotates it to the wind's bearing: because the staff points up and
 * a bearing is measured clockwise from north, the rotation is the bearing
 * itself, with no correction. This is the one place on the site where a wind
 * direction is *not* turned 180 degrees — an arrow has to point somewhere, but
 * a barb is a line, and the feathers are what say which end is upwind.
 *
 * A calm draws nothing here: it is marked by `CALM_RINGS` instead, which the
 * caller places, because a ring is not a shape a staff-and-feathers path can
 * carry without being filled.
 *
 * @param {number} speed - Wind speed, in km/h
 * @returns {string} SVG path data, or an empty string for a calm
 */
export function barbPath(speed) {
    const {calm, pennants, feathers, halves} = barbCounts(speed);

    if (calm) return '';

    let path = `M0 0L0 -${STAFF}`;

    // Laid out from the tail down toward the point, heaviest mark first, which
    // is the order the notation is read in — starting inside the tip, so the
    // staff is always visible past the outermost mark.
    let offset = STAFF - OVERHANG;

    if (pennants) {
        // A solid triangle standing on the staff, closed so that it fills.
        return `${path}${feather(offset, FEATHER_LENGTH)}L0 -${(offset - FEATHER_STEP).toFixed(1)}Z`;
    }

    for (let i = 0; i < feathers; i++) {
        path += feather(offset, FEATHER_LENGTH);
        offset -= FEATHER_STEP;
    }

    // In the outermost free slot, including when it is the only mark. The
    // textbook steps a lone half feather in from the tail so it cannot be
    // mistaken for a full one; that rule is for charts whose staff stops at its
    // outermost mark. Here the staff always overhangs, so the two are told
    // apart by length, and stepping it in only left a puzzling gap at the tail.
    if (halves) path += feather(offset, FEATHER_LENGTH / 2);

    return path;
}
