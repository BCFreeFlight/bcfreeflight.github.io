/**
 * Numbers, and the tables that interpret them.
 *
 * A station reports nothing as often as it reports something, so the question
 * "is this a reading at all?" is asked everywhere: before formatting it, before
 * charting it, before looking it up in a table. It is answered once here.
 */

/**
 * Whether a value is a number worth using.
 *
 * Deliberately stricter than `Number.isFinite`: the API sends nulls for a sensor
 * a station does not carry, and a null coerces to zero, which would read as a
 * calm wind rather than as no anemometer.
 *
 * @param {*} value - A raw reading
 * @returns {boolean} True when the value is a usable number
 */
export function isNumber(value) {
    return value !== null && value !== undefined && !Number.isNaN(Number(value));
}

/**
 * A reading at a fixed number of decimals, or a stand-in when there is none.
 * @param {*} value - A raw reading
 * @param {number} [digits=1] - Decimal places
 * @param {*} [fallback=null] - Returned when the value is not a number
 * @returns {string|*} The fixed-point value, or the fallback
 */
export function fixed(value, digits = 1, fallback = null) {
    return isNumber(value) ? Number(value).toFixed(digits) : fallback;
}

/**
 * The band a reading falls in.
 *
 * Both table shapes in the configuration are understood: most are written as
 * ascending ceilings and matched with `value <= max`, while wind chill runs the
 * other way and is matched with `value >= min`. Either way the first entry that
 * accepts the value wins, so the tables stay readable as ordered ranges.
 *
 * @param {Object[]} table - A band table from the configuration
 * @param {number} value - The reading to place
 * @returns {?Object} The matching band, or null when the table does not cover it
 */
export function band(table, value) {
    return table.find(entry =>
        entry.min === undefined ? value <= entry.max : value >= entry.min) ?? null;
}
