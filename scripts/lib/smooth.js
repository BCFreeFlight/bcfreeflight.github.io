/**
 * Taking the twitch out of a series without moving it.
 */

/**
 * A 1-2-1 binomial pass over a series, gaps left as gaps.
 *
 * The filter the Canadian RASP runs over its own cloudbase and top-of-lift
 * rows, and it is applied here to the same kind of quantity: a crossing, where
 * one curve meets another. Those are far twitchier than the readings behind
 * them — a tenth of a degree of wobble in a temperature profile steps the
 * height where the parcel curve crosses it by hundreds of metres — so left raw
 * they come out visibly jagged against a day that was not.
 *
 * Weighted so the reading keeps half of its own value and lends a quarter to
 * each side, which takes the spikes off without shifting the shape or moving a
 * peak off the hour it happened on.
 *
 * An end, or a value next to a gap, is left exactly as it was rather than
 * averaged against nothing: half a window is a different filter, and applying
 * it only at the edges would bend the ends of every line.
 *
 * @param {Array<?number>} values - The series, in order
 * @returns {Array<?number>} The smoothed series
 */
export function binomial(values) {
    return values.map((value, index) => {
        if (value === null || value === undefined) return null;

        const before = values[index - 1];
        const after = values[index + 1];

        if (before === null || before === undefined) return value;
        if (after === null || after === undefined) return value;

        return (before + 2 * value + after) / 4;
    });
}
