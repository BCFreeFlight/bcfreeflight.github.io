import {describe, it, equal, ok} from './runner.js';
import {shadeColumn, cloudColumn} from '../scripts/sky-series.js';
import {SKY_SERIES} from '../scripts/config/series.js';

/**
 * Shade and cloud, as lines on the ordinary chart.
 *
 * The pair only earns its place if the two can be told apart, so that is what
 * most of this is about: shade is measured and counts everything between the
 * sensor and the sun, cloud is modelled and counts only cloud, and the gap
 * between them on a smoky afternoon is the reason to plot them together.
 *
 * Nothing here touches the network.
 */

// Vernon, and a summer day in it.
const LATITUDE = 50.28;
const LONGITUDE = -118.98;
const MIDNIGHT = Date.UTC(2026, 7, 10, 7, 0, 0);
const FIVE = 5 * 60 * 1000;

/**
 * A day of readings, in the shape the history reader hands over.
 * @param {Object} [options] - How many hours, and what the pyranometer read
 * @returns {Object} A day
 */
function day({hours = 12, solar = 600} = {}) {
    const count = Math.round(hours * 60 / 5);
    const times = Array.from({length: count}, (unused, index) => MIDNIGHT + index * FIVE);

    return {
        times,
        values: {
            solar: times.map((time, index) => typeof solar === 'function' ? solar(index, time) : solar)
        },
        dayStart: MIDNIGHT,
        dayEnd: MIDNIGHT + 86400000,
        offset: -7 * 3600000
    };
}

/**
 * An hourly cloud forecast over the same day.
 * @param {number|function} cover - The percentage, or a function of the hour
 * @param {number} [hours=12] - How many hours it covers
 * @returns {Object} A model in the shape the sounding service hands over
 */
function aloft(cover, hours = 12) {
    const times = Array.from({length: hours + 1}, (unused, index) => MIDNIGHT + index * 3600000);

    return {
        times,
        cloud: times.map((time, index) => typeof cover === 'function' ? cover(index) : cover),
        levels: [],
        share: times.map(() => null)
    };
}

describe('shade, as a line on the chart', () => {
    it('is a percentage of the sunlight that went missing', () => {
        const column = shadeColumn(day(), LATITUDE, LONGITUDE);
        const readings = column.filter(value => value !== null);

        ok(readings.length, 'the middle of the day can be read');
        ok(readings.every(value => value >= 0 && value <= 100), 'and all of it is a percentage');
    });

    it('reads higher when less sunlight arrives', () => {
        const mean = readings => {
            const values = readings.filter(value => value !== null);
            return values.reduce((total, value) => total + value, 0) / values.length;
        };

        const clear = mean(shadeColumn(day({solar: 900}), LATITUDE, LONGITUDE));
        const smoky = mean(shadeColumn(day({solar: 300}), LATITUDE, LONGITUDE));

        ok(smoky > clear, `${smoky}% under smoke should beat ${clear}% in the clear`);
    });

    it('leaves a gap at dawn and dusk rather than dividing by almost nothing', () => {
        const column = shadeColumn(day(), LATITUDE, LONGITUDE);

        equal(column[0], null, 'midnight says nothing');
        ok(column.some(value => value !== null), 'but the middle of the day does');
    });

    it('leaves a gap wherever the sensor did', () => {
        const readings = day({solar: (index) => index % 2 ? null : 600});
        const column = shadeColumn(readings, LATITUDE, LONGITUDE);

        // Every reading the station missed is a gap here, rather than a zero
        // that would draw as a cloudless sky it never reported.
        readings.values.solar.forEach((solar, index) => {
            if (solar === null) equal(column[index], null, `reading ${index} was missing`);
        });

        ok(column.some(value => value !== null), 'and the readings it did take are still plotted');
    });

    it('is not offered by a station with no pyranometer', () => {
        const dark = day();
        delete dark.values.solar;

        equal(shadeColumn(dark, LATITUDE, LONGITUDE), null);
    });

    it('is not offered without knowing where the station stands', () => {
        // The sun's height is the whole method, and that needs a coordinate.
        equal(shadeColumn(day(), undefined, undefined), null);
    });

    it('is not offered for a station that logged nothing', () => {
        equal(shadeColumn(null, LATITUDE, LONGITUDE), null);
        equal(shadeColumn({times: [], values: {}}, LATITUDE, LONGITUDE), null);
    });
});

describe('cloud cover, as a line on the chart', () => {
    it('gives every reading time the hour that covers it', () => {
        const times = [MIDNIGHT, MIDNIGHT + 30 * 60 * 1000, MIDNIGHT + 3600000];
        const column = cloudColumn(aloft(index => index * 10), times);

        equal(column[0], 0, 'midnight');
        equal(column[1], 0, 'half past is still nearer midnight than one');
        equal(column[2], 10, 'and one o\'clock has moved on');
    });

    it('draws a staircase rather than inventing a clearing between hours', () => {
        const readings = day({hours: 6});
        const column = cloudColumn(aloft(index => index % 2 ? 80 : 20), readings.times);
        const distinct = [...new Set(column)];

        equal(distinct.sort().join(), '20,80', 'only values the model published');
    });

    it('leaves a gap where the model says nothing', () => {
        const readings = day({hours: 6});
        const yesterday = {times: [MIDNIGHT - 86400000], cloud: [50]};

        equal(cloudColumn(yesterday, readings.times), null, 'yesterday does not answer for today');
    });

    it('is not offered when there is no model at all', () => {
        equal(cloudColumn(null, day().times), null);
        equal(cloudColumn({times: [], cloud: []}, day().times), null);
    });
});

describe('the two of them together', () => {
    it('share a panel and an axis, because they answer the same question', () => {
        const groups = new Set(SKY_SERIES.map(series => series.group));
        const units = new Set(SKY_SERIES.map(series => series.unit));

        equal(groups.size, 1, 'one group, so one stacked panel');
        equal(units.size, 1, 'one unit, so one scale');
        equal([...units][0], '%');
    });

    it('are offered as separate measurements, not one blended figure', () => {
        equal(SKY_SERIES.map(series => series.key).sort().join(), 'cloud,shade');
    });

    it('separate on a day with smoke and no cloud', () => {
        // What an Okanagan August looks like: the model sees a clear sky, the
        // pyranometer sees a third of the sunlight missing.
        const readings = day({solar: 420});
        const shade = shadeColumn(readings, LATITUDE, LONGITUDE).filter(value => value !== null);
        const cloud = cloudColumn(aloft(0), readings.times).filter(value => value !== null);

        ok(shade.some(value => value > 20), 'shade sees the smoke');
        ok(cloud.every(value => value === 0), 'and cloud does not, which is the point of two lines');
    });
});
