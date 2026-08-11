import {describe, it, equal, ok, close} from './runner.js';
import {isNumber, fixed, band} from '../scripts/lib/numbers.js';
import {readText, writeText, readJson, writeJson} from '../scripts/lib/storage.js';
import {nearestIndex, valueAt} from '../scripts/lib/series-time.js';
import {lapseRate, pairByElevation} from '../scripts/lib/lapse.js';
import {Loop} from '../scripts/lib/loop.js';
import {pointAt, POINTS} from '../scripts/config/compass.js';
import * as bands from '../scripts/config/bands.js';
import {colour, colours} from '../scripts/config/palette.js';
import {SERIES, AIR_SERIES, SKY_SERIES, LAPSE_COLOURS} from '../scripts/config/series.js';
import {STRIPS} from '../scripts/config/rasp.js';

describe('numbers: is this a reading at all?', () => {
    it('accepts numbers, including zero and negatives', () => {
        [0, -1, 15.8, -40, 1e-9].forEach(value => ok(isNumber(value), `${value} is a reading`));
    });

    it('rejects the ways a station reports nothing', () => {
        [null, undefined, NaN, 'not a number', {}].forEach(value =>
            ok(!isNumber(value), `${JSON.stringify(value)} is not a reading`));
    });

    it('treats zero as a reading rather than as absent', () => {
        // A calm wind and a broken anemometer are different answers, and the
        // difference is exactly this.
        equal(fixed(0, 1, '—'), '0.0');
    });

    it('formats to the digits asked for', () => {
        equal(fixed(15.789, 1), '15.8');
        equal(fixed(15.789, 2), '15.79');
        equal(fixed(15.789, 0), '16');
    });

    it('hands back the fallback when there is nothing to format', () => {
        equal(fixed(null, 1, '—'), '—');
        equal(fixed(undefined, 1, '—'), '—');
        equal(fixed(NaN, 2, 'n/a'), 'n/a');
    });
});

describe('numbers: placing a reading in a band', () => {
    it('reads a ceiling table forwards', () => {
        equal(band(bands.HUMIDITY, 29).description, 'Dry air, potential dehydration risk');
        equal(band(bands.HUMIDITY, 30).description, 'Dry air, potential dehydration risk');
        equal(band(bands.HUMIDITY, 30.1).description, 'Comfortable humidity, pleasant conditions');
    });

    it('reads a floor table backwards', () => {
        // Wind chill is the one table written as floors: the risk rises as the
        // number falls.
        equal(band(bands.WIND_CHILL, 5).description, 'Minimal wind chill risk');
        equal(band(bands.WIND_CHILL, 0).description, 'Minimal wind chill risk');
        equal(band(bands.WIND_CHILL, -0.1).description, 'Mild cold—light jacket');
        equal(band(bands.WIND_CHILL, -100).description, 'Extreme risk—avoid outdoor exposure');
    });

    it('covers every value a station could report', () => {
        const tables = [bands.LAPSE, bands.UV, bands.PRESSURE, bands.DEW_POINT,
            bands.HUMIDITY, bands.HEAT_INDEX, bands.WIND_CHILL];

        // An uncovered value used to be a crash rather than a missing word: the
        // old code read `.description` straight off the result of `find`.
        tables.forEach((table, index) => {
            [-1e6, -50, 0, 50, 1e6].forEach(value =>
                ok(band(table, value) !== null, `table ${index} covers ${value}`));
        });
    });

    it('keeps every band table sorted, or the first match is the wrong one', () => {
        [bands.LAPSE, bands.UV, bands.PRESSURE, bands.DEW_POINT, bands.HUMIDITY, bands.HEAT_INDEX]
            .forEach((table, index) => {
                const ceilings = table.map(entry => entry.max);
                equal(ceilings, [...ceilings].sort((a, b) => a - b), `table ${index} ascends`);
            });

        const floors = bands.WIND_CHILL.map(entry => entry.min);
        equal(floors, [...floors].sort((a, b) => b - a), 'wind chill descends');
    });

    it('ends every table with an open range', () => {
        [bands.LAPSE, bands.UV, bands.PRESSURE, bands.DEW_POINT, bands.HUMIDITY, bands.HEAT_INDEX]
            .forEach((table, index) => equal(table.at(-1).max, Infinity, `table ${index}`));

        equal(bands.WIND_CHILL.at(-1).min, Number.NEGATIVE_INFINITY);
    });
});

describe('compass', () => {
    it('has sixteen points', () => {
        equal(POINTS.length, 16);
        equal(new Set(POINTS.map(p => p.abbr)).size, 16, 'no duplicates');
    });

    it('names the four cardinals', () => {
        equal(pointAt(0).abbr, 'N');
        equal(pointAt(90).abbr, 'E');
        equal(pointAt(180).abbr, 'S');
        equal(pointAt(270).abbr, 'W');
    });

    it('keeps the sixteenths rather than collapsing them', () => {
        // NNW must stay NNW: rounding it to N would move a reading by 22 degrees.
        equal(pointAt(337.5).abbr, 'NNW');
        equal(pointAt(22.5).abbr, 'NNE');
        equal(pointAt(247.5).abbr, 'WSW');
    });

    it('splits each arc at its own midpoint', () => {
        equal(pointAt(11.24).abbr, 'N');
        equal(pointAt(11.25).abbr, 'NNE');
        equal(pointAt(348.74).abbr, 'NNW');
        equal(pointAt(348.75).abbr, 'N');
    });

    it('wraps a bearing outside the circle instead of falling over', () => {
        equal(pointAt(360).abbr, 'N');
        equal(pointAt(361).abbr, 'N');
        equal(pointAt(450).abbr, 'E');
        equal(pointAt(-90).abbr, 'W');
        equal(pointAt(-1).abbr, 'N');
    });

    it('writes every point out in words', () => {
        POINTS.forEach(point => ok(point.words && point.words.length > point.abbr.length, point.abbr));
        equal(pointAt(202.5).words, 'south-southwest');
    });
});

describe('storage', () => {
    const key = '__test_key';

    it('gives back what was put in', () => {
        writeText(key, 'fill');
        equal(readText(key, 'fit'), 'fill');
        localStorage.removeItem(key);
    });

    it('falls back when nothing is stored', () => {
        localStorage.removeItem(key);
        equal(readText(key, 'fit'), 'fit');
        equal(readJson(key, null), null);
    });

    it('round-trips structured preferences', () => {
        writeJson(key, ['temp', 'windSpeed']);
        equal(readJson(key, null), ['temp', 'windSpeed']);
        localStorage.removeItem(key);
    });

    it('treats an unparseable entry as absent rather than throwing', () => {
        localStorage.setItem(key, '{not json');
        equal(readJson(key, 'fallback'), 'fallback');
        localStorage.removeItem(key);
    });

    it('survives storage being unavailable', () => {
        // What a private-mode browser or a full quota looks like from here.
        const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { throw new Error('denied'); }
        });

        try {
            equal(readText(key, 'fit'), 'fit');
            equal(readJson(key, null), null);
            equal(writeText(key, 'fill'), false);
            equal(writeJson(key, {}), false);
        } finally {
            Object.defineProperty(window, 'localStorage', real);
        }
    });

    it('reports whether a write landed, so a caller can say so', () => {
        equal(writeJson(key, {a: 1}), true);
        localStorage.removeItem(key);
    });
});

describe('lining readings up in time', () => {
    const times = [0, 1000, 2000, 3000];

    it('finds the closest reading', () => {
        equal(nearestIndex(times, 0), 0);
        equal(nearestIndex(times, 1400), 1);
        equal(nearestIndex(times, 1600), 2);
        equal(nearestIndex(times, 99999), 3);
    });

    it('has nothing to find in an empty day', () => {
        equal(nearestIndex([], 0), -1);
        equal(nearestIndex(null, 0), -1);
        equal(nearestIndex(undefined, 0), -1);
    });

    it('reads a value that is near enough', () => {
        equal(valueAt(times, ['a', 'b', 'c', 'd'], 1100, 500), 'b');
    });

    it('refuses a reading that is too far away', () => {
        // Five-minute buckets rarely line up between stations, but an hour
        // apart is a different afternoon.
        equal(valueAt(times, ['a', 'b', 'c', 'd'], 5000, 500), null);
    });

    it('reports a gap in the column as a gap', () => {
        equal(valueAt(times, ['a', null, 'c', 'd'], 1000, 500), null);
    });

    it('has nothing to read without a column', () => {
        equal(valueAt(times, null, 1000, 500), null);
        equal(valueAt([], ['a'], 1000, 500), null);
    });
});

describe('lapse rate', () => {
    it('is negative when the air cools with height', () => {
        // The whole convention, in one check: warmer below, cooler above.
        close(lapseRate(20, 14, 2), -3);
    });

    it('is positive in an inversion', () => {
        close(lapseRate(14, 20, 2), 3);
    });

    it('is zero when two stations are at the same height', () => {
        equal(lapseRate(20, 14, 0), 0);
        equal(lapseRate(20, 14, 0.0005), 0);
    });

    it('does not care which way a negligible gap points', () => {
        equal(lapseRate(20, 14, -0.0005), 0);
    });

    it('scales with the height between the stations', () => {
        close(lapseRate(20, 14, 1), -6);
        close(lapseRate(20, 14, 3), -2);
    });
});

describe('pairing stations by elevation', () => {
    const at = feet => ({feet});
    const feet = entry => entry.feet;

    it('reads downhill whatever order it is given', () => {
        equal(pairByElevation([at(1000), at(5000), at(3000)], feet)
                .map(p => [p.upper.feet, p.lower.feet]),
            [[5000, 3000], [3000, 1000]]);
    });

    it('pairs the survivors when one drops out', () => {
        equal(pairByElevation([at(5000), at(1000)], feet).map(p => [p.upper.feet, p.lower.feet]),
            [[5000, 1000]]);
    });

    it('has no pairs with fewer than two stations', () => {
        equal(pairByElevation([at(5000)], feet), []);
        equal(pairByElevation([], feet), []);
    });

    it('leaves the array it was given alone', () => {
        const given = [at(1000), at(5000)];
        pairByElevation(given, feet);
        equal(given.map(feet), [1000, 5000], 'still in the order it was handed over');
    });
});

describe('the refresh loop', () => {
    it('runs the task after the delay', async () => {
        let ran = 0;
        const loop = new Loop(() => { ran += 1; });
        loop.in(5);
        await new Promise(resolve => setTimeout(resolve, 40));
        equal(ran, 1);
    });

    it('never leaves two timers running', async () => {
        // The bug this prevents: queue from three places, fetch three times as
        // often, forever.
        let ran = 0;
        const loop = new Loop(() => { ran += 1; });
        loop.in(5);
        loop.in(5);
        loop.in(5);
        await new Promise(resolve => setTimeout(resolve, 40));
        equal(ran, 1);
    });

    it('can be called off', async () => {
        let ran = 0;
        const loop = new Loop(() => { ran += 1; });
        loop.in(5);
        loop.cancel();
        await new Promise(resolve => setTimeout(resolve, 40));
        equal(ran, 0);
    });
});

describe('the palette', () => {
    it('hands back a colour by name', () => {
        ok(/^#[0-9a-f]{6}$/i.test(colour('series-temp')), colour('series-temp'));
    });

    it('resolves a token defined in terms of another', () => {
        // The wind line is the accent, said once. If the indirection stopped
        // resolving this would come back empty rather than blue.
        equal(colour('series-wind'), colour('accent'));
    });

    it('takes several at once, in order', () => {
        equal(colours('series-shade', 'series-cloud'),
            [colour('series-shade'), colour('series-cloud')]);
    });

    it('refuses a colour that is not in the palette', () => {
        // Loudly, rather than drawing something almost right: a token can only
        // fail to resolve if the stylesheet is missing altogether.
        try {
            colour('series-nothing-like-this');
            ok(false, 'should have thrown');
        } catch (error) {
            ok(error.message.includes('--series-nothing-like-this'), error.message);
            ok(error.message.includes('palette.css'), 'and says where to look');
        }
    });

    it('is the only place a colour is written down', () => {
        // The whole point. A hex code back in the configuration is a colour the
        // stylesheet cannot see, and the pair drift from there.
        const sources = ['series', 'rasp', 'bands'].map(name =>
            fetch(`../scripts/config/${name}.js`).then(response => response.text()));

        return Promise.all(sources).then(texts => texts.forEach((text, index) => {
            const hex = text.match(/#[0-9a-fA-F]{3,8}\b/g);
            equal(hex, null, `${['series', 'rasp', 'bands'][index]}.js: ${hex}`);
        }));
    });

    it('carries every colour the drawing code asks for', () => {
        // Reading each one is the assertion: a missing token throws.
        [...SERIES, AIR_SERIES, ...SKY_SERIES, ...STRIPS]
            .forEach(item => ok(item.colour.length, item.key));

        LAPSE_COLOURS.forEach(value => ok(value.length));
        [...bands.LAPSE, ...bands.AIR_QUALITY].forEach(band => ok(band.color.length, band.name));
    });
});
