/**
 * The compass.
 *
 * Sixteen points, each with the abbreviation a reading is written in and the
 * words for it. "SSW" is jargon; "south-southwest" is not, and the page has to
 * read for someone who has never seen a wind report.
 *
 * The bearings themselves are not listed because they are not free to choose:
 * the points divide the circle evenly, so each one owns the arc centred on it
 * and the point for a bearing is arithmetic rather than a lookup.
 */

export const POINTS = [
    {abbr: 'N', words: 'north'},
    {abbr: 'NNE', words: 'north-northeast'},
    {abbr: 'NE', words: 'northeast'},
    {abbr: 'ENE', words: 'east-northeast'},
    {abbr: 'E', words: 'east'},
    {abbr: 'ESE', words: 'east-southeast'},
    {abbr: 'SE', words: 'southeast'},
    {abbr: 'SSE', words: 'south-southeast'},
    {abbr: 'S', words: 'south'},
    {abbr: 'SSW', words: 'south-southwest'},
    {abbr: 'SW', words: 'southwest'},
    {abbr: 'WSW', words: 'west-southwest'},
    {abbr: 'W', words: 'west'},
    {abbr: 'WNW', words: 'west-northwest'},
    {abbr: 'NW', words: 'northwest'},
    {abbr: 'NNW', words: 'north-northwest'}
];

// 22.5 degrees, but derived, so the two cannot disagree if a coarser compass is
// ever wanted.
export const ARC = 360 / POINTS.length;

/**
 * The compass point a bearing falls on.
 *
 * Bearings outside the circle are wrapped rather than rejected: a station that
 * reports 370º means 10º, and one that reports -5º means 355º.
 *
 * @param {number} degrees - A bearing
 * @returns {Object} The point: its abbreviation and its words
 */
export function pointAt(degrees) {
    const normalised = ((degrees % 360) + 360) % 360;
    return POINTS[Math.round(normalised / ARC) % POINTS.length];
}
