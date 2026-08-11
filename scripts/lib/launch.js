/**
 * Which way a launch faces, and whether the wind agrees with it.
 *
 * A launch is only flyable through part of the compass: the slope faces one
 * way, and wind arriving from behind or across it is not the same weather at
 * all. Cooper's runs from 100º to 144º, so an easterly is on the hill and a
 * westerly is over the back.
 *
 * The window is written the way a polygon is wound — clockwise, start to end —
 * so it reads the same as the map it came from and there is never a question of
 * which of the two bearings is which. That also makes a window across north
 * unambiguous: 340º to 20º is the forty degrees through north, not the three
 * hundred and twenty the other way round.
 */

const CIRCLE = 360;

/**
 * Wraps a bearing into the circle.
 * @param {number} degrees - Any bearing
 * @returns {number} The same bearing from 0 up to but not including 360
 */
function wrap(degrees) {
    return ((degrees % CIRCLE) + CIRCLE) % CIRCLE;
}

/**
 * Reads a launch window out of configuration.
 *
 * Both bearings have to be numbers for the window to mean anything, so a
 * partial one is no window rather than half of one — a station with a typo in
 * its configuration should show an uncoloured arrow, not a confidently wrong
 * one.
 *
 * Only the bearings. Where the launch is belongs to the station rather than to
 * its window: every station has a position and only some of them have a
 * direction, and a coordinate hidden inside a launch node would be a coordinate
 * two of the three stations had nowhere to put.
 *
 * @param {?Object} launch - The configured window: start and end, in degrees
 * @returns {?Object} start and end, wrapped into the circle, or null
 */
export function launchWindow(launch) {
    if (!Number.isFinite(launch?.start) || !Number.isFinite(launch?.end)) return null;

    return {start: wrap(launch.start), end: wrap(launch.end)};
}

/**
 * How wide a window is, going clockwise from its start.
 * @param {Object} window - A window from launchWindow
 * @returns {number} Degrees, from 0 to 360
 */
export function windowWidth({start, end}) {
    // A window that ends where it starts is a full circle rather than a point:
    // nobody configures a launch flyable from exactly one bearing.
    return start === end ? CIRCLE : wrap(end - start);
}

/**
 * Whether the wind is coming in on the launch.
 *
 * Tested against the bearing the wind blows *from*, which is what a station
 * reports and what the launch bearings describe. The arrow on the page points
 * the other way, but that is a drawing decision and has nothing to do with this.
 *
 * @param {?number} bearing - Where the wind is blowing from, in degrees
 * @param {?Object} window - A window from launchWindow
 * @returns {?boolean} True on the hill, false over the back, null when unknown
 */
export function facingLaunch(bearing, window) {
    if (!window || !Number.isFinite(bearing)) return null;

    // Both ends count as on: a launch bearing is a judgement about terrain, not
    // a boundary anyone measured to the degree.
    return wrap(bearing - window.start) <= windowWidth(window);
}
