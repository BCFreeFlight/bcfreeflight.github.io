/**
 * Lining readings up in time.
 *
 * Stations log on their own schedule, so nothing lines up exactly: a crosshair
 * lands between two readings, and two stations five minutes apart never share a
 * timestamp. Both questions are the same one — which reading is nearest this
 * moment — and how far is too far is left to the caller, because a chart reading
 * out a value and a lapse rate pairing two stations disagree about it.
 */

/**
 * The reading closest to a moment.
 * @param {?number[]} times - Reading times, in milliseconds
 * @param {number} time - The moment being matched
 * @returns {number} Its index, or -1 when there are no readings
 */
export function nearestIndex(times, time) {
    if (!times?.length) return -1;

    let best = 0;
    for (let i = 1; i < times.length; i++) {
        if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i;
    }

    return best;
}

/**
 * The value a column held at a moment, if it held one near enough.
 * @param {?number[]} times - Reading times, in milliseconds
 * @param {?Array} column - The values beside them
 * @param {number} time - The moment being matched
 * @param {number} tolerance - How far away a reading may sit and still count
 * @returns {?*} The value, or null when nothing lines up
 */
export function valueAt(times, column, time, tolerance) {
    if (!column) return null;

    const index = nearestIndex(times, time);
    if (index === -1 || Math.abs(times[index] - time) > tolerance) return null;

    return column[index];
}
