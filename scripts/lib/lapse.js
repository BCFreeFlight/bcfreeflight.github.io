/**
 * Lapse rate: how fast the air cools with height.
 *
 * The sign convention is the whole point and it is easy to get backwards, so it
 * is written once: cooling with height is **negative**, an inversion is
 * positive. Everything on the site — the tag beside the tabs, the tile on the
 * video, the line on the chart — reads the same way because it all comes
 * through here.
 */

// Two stations at what amounts to the same height cannot describe a lapse
// between them, and dividing by that gap would report a wild number from a
// rounding difference.
export const MINIMUM_GAP = 0.001;

/**
 * The lapse rate between two temperatures a known height apart.
 * @param {number} lowerTemp - Temperature at the lower station, in ºC
 * @param {number} upperTemp - Temperature at the upper station, in ºC
 * @param {number} gapThousandFeet - Height between them, in thousands of feet
 * @returns {number} ºC per 1000 ft: negative when the air cools with height
 */
export function lapseRate(lowerTemp, upperTemp, gapThousandFeet) {
    return Math.abs(gapThousandFeet) < MINIMUM_GAP
        ? 0
        : -((lowerTemp - upperTemp) / gapThousandFeet);
}

/**
 * Adjacent pairs of stations, highest first.
 *
 * Ranking by the elevation each station reports rather than by its place in the
 * configuration means the segments always read downhill — Silver Star to
 * Launch, then Launch to the Landing Zone — and a station that has dropped out
 * lets its neighbours pair up instead of leaving a hole.
 *
 * @param {Object[]} entries - Whatever the caller is pairing
 * @param {function(Object): number} elevationOf - Reads an entry's elevation
 * @returns {Object[]} One {upper, lower} per adjacent pair
 */
export function pairByElevation(entries, elevationOf) {
    const ranked = [...entries].sort((a, b) => elevationOf(b) - elevationOf(a));
    const pairs = [];

    for (let i = 0; i < ranked.length - 1; i++) {
        pairs.push({upper: ranked[i], lower: ranked[i + 1]});
    }

    return pairs;
}
