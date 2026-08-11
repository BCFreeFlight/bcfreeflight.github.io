import {describe, it, equal, ok} from './runner.js';
import {launchWindow, windowWidth, facingLaunch} from '../scripts/lib/launch.js';
import sites from '../scripts/sites.js';
import index from '../scripts/index.js';
import * as readings from '../scripts/readings.js';

/**
 * Which way the launch faces, and what the arrow does about it.
 *
 * Cooper's is flyable from 100º to 144º, wound clockwise the way a polygon is.
 * The arrow on the weather page turns red outside that, and stays the ordinary
 * blue both inside it and at every station that has no launch at all — the two
 * look the same on screen, and that is the point: no launch means no opinion,
 * not a passing grade.
 *
 * Nothing here touches the network beyond the site's own configuration file.
 */

const COOPERS = {start: 100, end: 144};

// The real configuration, not a fixture: a launch window nobody reads would be
// worth nothing, and this is what catches it going missing.
const site = await sites.site('coopers');

/**
 * A station observation carrying nothing but a wind direction.
 * @param {?number} degrees - Where the wind is blowing from
 * @returns {Object} An observation
 */
function blowingFrom(degrees) {
    return {winddir: degrees, uk_hybrid: {windSpeed: 12, windGust: 12}};
}

describe('reading a launch window out of configuration', () => {
    it('takes a pair of bearings', () => {
        equal(launchWindow(COOPERS), {start: 100, end: 144});
    });

    it('wraps bearings written outside the circle', () => {
        equal(launchWindow({start: 370, end: -10}), {start: 10, end: 350});
    });

    it('is no window at all when either bearing is missing or unreadable', () => {
        // Half a window would draw a confident colour off a typo.
        equal(launchWindow(null), null);
        equal(launchWindow(undefined), null);
        equal(launchWindow({start: 100}), null);
        equal(launchWindow({end: 144}), null);
        equal(launchWindow({start: 'east', end: 144}), null);
        equal(launchWindow({start: 100, end: NaN}), null);
    });
});

describe('how wide a window is', () => {
    it('measures clockwise from its start', () => {
        equal(windowWidth({start: 100, end: 144}), 44);
    });

    it('carries on through north rather than turning back', () => {
        // 340º to 20º is the forty degrees through north, not the 320 the other
        // way round. Winding is what tells the two apart.
        equal(windowWidth({start: 340, end: 20}), 40);
    });

    it('reads a window written the other way round as the long way round', () => {
        // Not a mistake to correct: a shallow west-facing bowl really can be
        // flyable through most of the compass, and only the winding says so.
        equal(windowWidth({start: 144, end: 100}), 316);
    });

    it('treats a window that ends where it starts as the whole circle', () => {
        equal(windowWidth({start: 90, end: 90}), 360);
    });
});

describe('is the wind on the hill?', () => {
    it('says yes through the window', () => {
        [100, 110, 122, 143, 144].forEach(bearing =>
            ok(facingLaunch(bearing, COOPERS), `${bearing}º is on the hill`));
    });

    it('says no outside it', () => {
        [99, 145, 180, 244, 0, 359].forEach(bearing =>
            ok(!facingLaunch(bearing, COOPERS), `${bearing}º is not on the hill`));
    });

    it('counts both edges as on, because a launch bearing is a judgement', () => {
        ok(facingLaunch(100, COOPERS), 'the first bearing');
        ok(facingLaunch(144, COOPERS), 'the last bearing');
    });

    it('answers across north without falling out of the circle', () => {
        const northerly = {start: 340, end: 20};

        ok(facingLaunch(350, northerly), 'before midnight');
        ok(facingLaunch(0, northerly), 'at north');
        ok(facingLaunch(10, northerly), 'after it');
        ok(!facingLaunch(180, northerly), 'and not the far side');
    });

    it('wraps a station that reports outside the circle', () => {
        equal(facingLaunch(460, COOPERS), true, '460º is 100º');
        equal(facingLaunch(-240, COOPERS), true, '-240º is 120º');
    });

    it('has nothing to say without a window', () => {
        // Null rather than false: a station with no launch is not reporting an
        // unflyable wind, it is reporting a wind about nowhere in particular.
        equal(facingLaunch(244, null), null);
        equal(facingLaunch(244, undefined), null);
    });

    it('has nothing to say without a reading', () => {
        equal(facingLaunch(null, COOPERS), null);
        equal(facingLaunch(undefined, COOPERS), null);
        equal(facingLaunch(NaN, COOPERS), null);
    });
});

describe('the launch, in the real site configuration', () => {
    const launch = site.stations.find(station => station.isDefault);
    const others = site.stations.filter(station => !station.isDefault);

    it('stands at the default station, which is the one on the hill', () => {
        equal(launch.launch, {start: 100, end: 144});
    });

    it('is not claimed by the stations that are not launches', () => {
        ok(others.length, 'there are reference stations to check');
        others.forEach(station =>
            equal(station.launch, null, `${station.name} is not a launch`));
    });

    it('is absent from a station that does not configure one', () => {
        equal(sites.station({wunderground: 'IABCDEF1'}, 0).launch, null);
    });
});

describe('the wind reading, at a launch and away from one', () => {
    it('reports the wind on the hill', () => {
        equal(readings.wind(blowingFrom(122), COOPERS).onLaunch, true);
    });

    it('reports the wind over the back', () => {
        equal(readings.wind(blowingFrom(244), COOPERS).onLaunch, false);
    });

    it('reports nothing at a station with no launch', () => {
        equal(readings.wind(blowingFrom(244)).onLaunch, null);
        equal(readings.wind(blowingFrom(244), null).onLaunch, null);
    });

    it('reports nothing when the vane is not reporting', () => {
        equal(readings.wind(blowingFrom(null), COOPERS).onLaunch, null);
        equal(readings.wind(null, COOPERS).onLaunch, null);
    });

    it('leaves every other part of the reading alone', () => {
        const bare = readings.wind(blowingFrom(244));
        const launch = readings.wind(blowingFrom(244), COOPERS);

        equal(launch.cardinal, bare.cardinal);
        equal(launch.rotation, bare.rotation);
        equal(launch.summary, bare.summary);
    });
});

describe('the arrow on the weather page', () => {
    /**
     * The arrow's markup for a wind from one bearing.
     * @param {number} degrees - Where the wind is blowing from
     * @param {?Object} launch - The station's window, if it has one
     * @returns {string} HTML markup
     */
    const arrow = (degrees, launch = null) =>
        index.renderWindArrow(readings.wind(blowingFrom(degrees), launch));

    it('turns red when the wind is outside the launch direction', () => {
        ok(arrow(244, COOPERS).includes('is-off-launch'));
    });

    it('stays blue when the wind is inside it', () => {
        ok(!arrow(122, COOPERS).includes('is-off-launch'));
    });

    it('stays blue at a station with no launch, whichever way the wind blows', () => {
        // The colour never means "fine" by default. A station that cannot
        // answer the question draws the same arrow it always did.
        [0, 90, 244, 300].forEach(bearing =>
            ok(!arrow(bearing).includes('is-off-launch'), `${bearing}º says nothing`));
    });

    it('stays blue when the vane reports nothing', () => {
        ok(!arrow(null, COOPERS).includes('is-off-launch'));
    });

    it('says it in words as well as in colour', () => {
        // A colour alone is no answer through a screen reader, or to anyone who
        // cannot tell this red from this blue.
        ok(arrow(244, COOPERS).includes('outside the launch direction'));
        ok(!arrow(122, COOPERS).includes('outside the launch direction'));
        ok(!arrow(244).includes('outside the launch direction'));
    });

    it('still points the way the wind is going', () => {
        // Colour is the only thing the window changes; the rotation is still
        // 180º off the bearing, red or blue.
        ok(arrow(244, COOPERS).includes('rotate(424deg)'));
        ok(arrow(122, COOPERS).includes('rotate(302deg)'));
    });
});
