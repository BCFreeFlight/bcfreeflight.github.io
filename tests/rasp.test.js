import {describe, it, equal, ok, close, fixture} from './runner.js';
import {SERIES} from '../scripts/config/series.js';
import {History} from '../scripts/history.js';
import {buildWindgram, FEET} from '../scripts/rasp.js';
import {Windgram} from '../scripts/windgram.js';
import {Chart} from '../scripts/chart.js';
import {barbCounts, barbPath, PENNANT, MAXIMUM_FEATHERS, CALM_RINGS} from '../scripts/lib/barb.js';
import {sunHeight, clearSky, shadeFraction, sunTimes} from '../scripts/lib/solar.js';
import {temperatureAt, thermalTop, updraft, heatFlux, climbTop, DRY_ADIABAT, HEAT_FRACTION, GLIDER_SINK} from '../scripts/lib/thermal.js';
import {CEILING, COLUMN_MS, STRIPS} from '../scripts/config/rasp.js';
import {reveal} from '../scripts/lib/reveal.js';

/**
 * The windgram.
 *
 * Most of this file exists because of bugs that were caught by looking at the
 * drawing rather than by reasoning about it, and every one of them was a case
 * of the arithmetic being right and the meaning being wrong: a barometer strip
 * that stepped six kilopascals because it took whichever station happened to be
 * awake, cloud hatched across the whole sky because two extrapolated lines
 * always cross eventually, thermals reported at three in the morning. Those are
 * the cases pinned down here.
 *
 * Nothing here touches the network. The fixtures are captured API responses and
 * the rest is built by hand.
 */

const history = new History();
const days = {};

for (const id of ['ILUMBY7', 'ILUMBY8', 'IVERNO71']) {
    const rows = (await fixture(`day-${id}`)).observations;
    const times = rows.map(row => row.epoch * 1000);
    const values = {};

    for (const series of SERIES) {
        const column = rows.map(row => {
            const value = series.read(row);
            return value === null || value === undefined || Number.isNaN(Number(value))
                ? null : Number(value);
        });
        if (column.some(value => value !== null)) values[series.key] = column;
    }

    days[id] = {times, values, ...history.dayBounds(rows[0])};
}

const STATIONS = {
    ILUMBY8: {key: 'ilumby8', id: 'ILUMBY8', name: 'Freedom Flight Park', shortName: 'FFP'},
    ILUMBY7: {key: 'ilumby7', id: 'ILUMBY7', name: "Cooper's Launch", shortName: 'Coopers', isDefault: true},
    IVERNO71: {key: 'iverno71', id: 'IVERNO71', name: 'Silver Star', shortName: 'SilverStar'}
};

const ELEVATIONS = {ILUMBY8: 1624, ILUMBY7: 3466, IVERNO71: 5453};

/**
 * The three real stations, as buildWindgram takes them.
 * @returns {Object[]} Entries
 */
function real() {
    return ['ILUMBY8', 'ILUMBY7', 'IVERNO71'].map(id => ({
        station: STATIONS[id],
        elevationFeet: ELEVATIONS[id],
        latitude: 50.28,
        longitude: -118.98,
        day: days[id]
    }));
}

// A fixed midnight, so nothing here depends on when the tests are run.
const MIDNIGHT = Date.UTC(2026, 7, 10, 7, 0, 0);
const FIVE = 5 * 60 * 1000;

/**
 * A day built to order, in the shape the history reader hands over.
 * @param {Object} options - How many readings, and what each column holds
 * @returns {Object} A day
 */
function staged({hours = 6, from = 6, ...columns} = {}) {
    const count = Math.round(hours * 60 / 5);

    // Readings start in the morning rather than at midnight, because the
    // drawing's window now runs from an hour before sunrise: a day staged from
    // midnight would have most of its readings outside the frame.
    const times = Array.from({length: count},
        (unused, index) => MIDNIGHT + from * 60 * 60 * 1000 + index * FIVE);

    const values = {};
    Object.entries(columns).forEach(([key, value]) => {
        values[key] = times.map((time, index) =>
            typeof value === 'function' ? value(index, time) : value);
    });

    return {times, values, dayStart: MIDNIGHT, dayEnd: MIDNIGHT + 86400000, offset: -7 * 3600000};
}

/**
 * A two-station column of air, built to a chosen profile.
 * @param {Object} lower - temp, dewpt, solar at the valley station
 * @param {Object} upper - temp, dewpt at the hill station
 * @returns {Object[]} Entries
 */
function profile(lower, upper) {
    return [
        {
            station: STATIONS.ILUMBY7,
            elevationFeet: 1000,
            latitude: 50.28,
            longitude: -118.98,
            day: staged({temp: lower.temp, dewpt: lower.dewpt ?? -20, solar: lower.solar ?? 0,
                windSpeed: 10, windDir: 270, pressure: 101.5})
        },
        {
            station: STATIONS.IVERNO71,
            elevationFeet: 5000,
            latitude: 50.28,
            longitude: -118.98,
            day: staged({temp: upper.temp, dewpt: upper.dewpt ?? -20, windSpeed: 12, windDir: 280})
        }
    ];
}

/**
 * Renders a windgram offscreen and hands back its markup.
 * @param {?Object} model - A model from buildWindgram
 * @param {number} [width=900] - The width to draw at
 * @returns {string} The markup
 */
function draw(model, width = 900) {
    const host = document.createElement('div');
    host.style.cssText = `width:${width}px;position:absolute;left:-9999px;top:0`;
    document.body.appendChild(host);

    const windgram = new Windgram(host);
    windgram.setModel(model);

    const markup = host.innerHTML;
    windgram.destroy();
    host.remove();

    return markup;
}

describe('wind barbs', () => {
    /**
     * @param {number} speed - Wind speed, in km/h
     * @returns {Object} pennants, feathers and halves, without the calm flag
     */
    const marks = speed => {
        const {pennants, feathers, halves} = barbCounts(speed);
        return {pennants, feathers, halves};
    };

    // The scale, written out exactly as it is read off the drawing.
    const SCALE = [
        [5, {pennants: 0, feathers: 0, halves: 1}, 'one half feather'],
        [10, {pennants: 0, feathers: 1, halves: 0}, 'one full feather'],
        [15, {pennants: 0, feathers: 1, halves: 1}, 'a full feather and a half'],
        [20, {pennants: 0, feathers: 2, halves: 0}, 'two full feathers'],
        [25, {pennants: 0, feathers: 2, halves: 1}, 'two full feathers and a half'],
        [30, {pennants: 0, feathers: 3, halves: 0}, 'three full feathers']
    ];

    SCALE.forEach(([speed, expected, notation]) => {
        it(`draws ${notation} for ${speed} km/h`, () => {
            equal(marks(speed), expected);
        });
    });

    it('calls nothing at all a calm', () => {
        equal(barbCounts(0).calm, true);
        equal(barbCounts(2).calm, true, 'and anything that rounds to nothing');
        equal(barbCounts(5).calm, false);
    });

    it('draws no staff for a calm, because a calm has no direction', () => {
        equal(barbPath(0), '');
    });

    it('marks a calm with two rings instead', () => {
        equal(CALM_RINGS.length, 2);
        ok(CALM_RINGS[0] < CALM_RINGS[1], 'one inside the other');
    });

    it('holds at three full feathers from thirty until the pennant', () => {
        [30, 35, 40, 65, 85].forEach(speed => {
            equal(marks(speed), {pennants: 0, feathers: MAXIMUM_FEATHERS, halves: 0}, `${speed} km/h`);
        });
    });

    it('gives way to a pennant at ninety', () => {
        equal(marks(PENNANT), {pennants: 1, feathers: 0, halves: 0});
        equal(marks(120), {pennants: 1, feathers: 0, halves: 0});
        equal(marks(PENNANT - 5), {pennants: 0, feathers: MAXIMUM_FEATHERS, halves: 0});
    });

    it('fills the pennant, and nothing else', () => {
        ok(barbPath(PENNANT).includes('Z'), 'the pennant is a closed path');
        [5, 10, 20, 30].forEach(speed =>
            ok(!barbPath(speed).includes('Z'), `${speed} km/h is open lines`));
    });

    it('rounds to the nearest five, because there is no mark for seven', () => {
        equal(marks(7), marks(5));
        equal(marks(8), marks(10));
        equal(barbPath(8), barbPath(10), 'and draws them identically');
        equal(marks(3), marks(5));
    });

    it('rounds half a step up, as arithmetic does', () => {
        equal(marks(2.5), marks(5));
        equal(marks(12.5), marks(15));
    });

    it('draws a staff at every speed that is not a calm', () => {
        [5, 10, 15, 30, PENNANT].forEach(speed => {
            ok(barbPath(speed).startsWith('M0 0L0 -'), `${speed} km/h has a staff`);
        });
    });

    it('draws one stroke per mark, on top of the staff', () => {
        // Each mark is its own subpath, so counting moves counts marks.
        const strokes = speed => barbPath(speed).split('M').length - 1;

        equal(strokes(5), 2, 'staff and a half feather');
        equal(strokes(20), 3, 'staff and two feathers');
        equal(strokes(25), 4, 'staff, two feathers and a half');
        equal(strokes(30), 4, 'staff and three feathers');
    });

    /**
     * Where each mark sits along the staff, and how far it reaches out. Read
     * off the path rather than hard-coded, so the geometry can be retuned
     * without rewriting the assertions.
     * @param {number} speed - Wind speed, in km/h
     * @returns {Object} staff length, and each mark's offset and reach
     */
    function geometry(speed) {
        const path = barbPath(speed);
        const moves = path.split('M').filter(Boolean);

        return {
            staff: parseFloat(path.match(/^M0 0L0 -([\d.]+)/)[1]),
            marks: moves.slice(1).map(move => ({
                offset: Math.abs(parseFloat(move.split('L')[0].split(' ')[1])),
                reach: parseFloat(move.split('L')[1].split(' ')[0])
            }))
        };
    }

    it('puts a lone half feather at the tail, not stepped in behind a gap', () => {
        equal(geometry(5).marks[0].offset, geometry(10).marks[0].offset,
            'the same slot a full feather would take');
    });

    it('tells a half feather from a full one by its length', () => {
        // Which is what lets a lone half sit in the outermost slot at all.
        // The tolerance is the path's own: coordinates are written to one
        // decimal, so half of 9.5 cannot come back as exactly 4.75.
        close(geometry(5).marks[0].reach, geometry(10).marks[0].reach / 2, 0.06);
    });

    it('carries the staff past the outermost feather', () => {
        // Without this the feather joined the end of the staff at a corner and
        // the two read as one bent line: a ten kilometre wind came out as an
        // "L" rather than as a staff with a feather on it.
        [10, 20, 30].forEach(speed => {
            const {staff, marks: on} = geometry(speed);
            ok(staff > on[0].offset + 2,
                `${speed} km/h: staff ${staff} should overhang its feather at ${on[0].offset}`);
        });
    });

    it('stands the feathers off the staff at 120 degrees', () => {
        const {marks: on} = geometry(10);
        const [mark] = on;

        // The feather runs from its offset up the staff and outward; the angle
        // from the staff's own outward direction is what makes that 120º.
        const along = parseFloat(barbPath(10).split('M')[2].split('L')[1].split(' ')[1]) * -1 - mark.offset;
        const degrees = Math.atan2(mark.reach, along) * 180 / Math.PI;

        close(180 - degrees, 120, 0.5);
    });

    it('stacks the feathers down the staff, heaviest first', () => {
        const {marks: on} = geometry(25);

        ok(on[0].offset > on[1].offset, 'second feather sits below the first');
        ok(on[1].offset > on[2].offset, 'and the half below both');
        close(on[2].reach, on[0].reach / 2, 0.06, 'the half is the short one');
    });
});

describe('where the sun is', () => {
    // MIDNIGHT is local, so these are hours into the station's own day.
    const noon = MIDNIGHT + 13 * 3600000;

    it('is higher at midday than first thing', () => {
        ok(sunHeight(noon, 50.28, -118.98) > sunHeight(MIDNIGHT + 7 * 3600000, 50.28, -118.98));
    });

    it('is on the floor in the middle of the night', () => {
        equal(sunHeight(MIDNIGHT + 3 * 3600000, 50.28, -118.98), 0);
    });

    it('is higher at the equator than in the Okanagan, in August', () => {
        ok(sunHeight(noon, 0, -118.98) > 0);
        ok(sunHeight(noon, 50.28, -118.98) < 0.95, 'never overhead this far north');
    });

    it('gives no clear-sky sunlight at night', () => {
        equal(clearSky(0, noon), 0);
    });

    it('gives a believable clear-sky figure at midday in August', () => {
        const value = clearSky(sunHeight(noon, 50.28, -118.98), noon);
        ok(value > 600 && value < 950, `got ${value} W/m²`);
    });
});

describe('reading shade off a pyranometer', () => {
    it('reports none when the reading matches a clear sky', () => {
        equal(shadeFraction(800, 800), 0);
    });

    it('reports half when half the sunlight is missing', () => {
        close(shadeFraction(400, 800), 0.5, 0.001);
    });

    it('does not report negative shade when the sensor beats the model', () => {
        equal(shadeFraction(900, 800), 0);
    });

    it('refuses to answer when the sun is too low to tell', () => {
        // The whole reason this exists: a low sun behind a ridge divided by a
        // near-zero clear-sky figure used to read as a solid overcast every
        // morning.
        equal(shadeFraction(10, 40), null);
    });

    it('refuses to answer when there is no reading', () => {
        equal(shadeFraction(null, 800), null);
        equal(shadeFraction(undefined, 800), null);
    });
});

describe('the temperature profile', () => {
    const levels = [
        {elevation: 500, temp: 20},
        {elevation: 1000, temp: 15},
        {elevation: 1500, temp: 12}
    ];

    it("reads a station's own height back exactly", () => {
        equal(temperatureAt(levels, 1000).temp, 15);
    });

    it('interpolates between two stations', () => {
        close(temperatureAt(levels, 750).temp, 17.5, 1e-9);
    });

    it('does not call a reading between stations extrapolated', () => {
        equal(temperatureAt(levels, 750).extrapolated, false);
    });

    it('continues the top gradient above the highest station, and says so', () => {
        const above = temperatureAt(levels, 2000);
        close(above.temp, 9, 1e-9);
        equal(above.extrapolated, true);
    });

    it('has nothing to say with no levels', () => {
        equal(temperatureAt([], 1000), null);
    });
});

describe('how high a thermal gets', () => {
    // Cooling faster than the dry adiabat: a parcel stays buoyant all the way.
    const unstable = [{elevation: 500, temp: 30}, {elevation: 1500, temp: 5}];

    // An inversion: warmer above than below, so nothing goes anywhere.
    const inverted = [{elevation: 500, temp: 10}, {elevation: 1500, temp: 15}];

    it('runs to the ceiling when the air keeps cooling fast enough', () => {
        equal(thermalTop(unstable, 3000), 3000);
    });

    it('finds nothing under an inversion, given nothing to trigger on', () => {
        equal(thermalTop(inverted, 3000, {trigger: 0}), null);
    });

    it('gets only a little way into a weak inversion on the trigger alone', () => {
        // Five degrees per kilometre of inversion is not much, and the default
        // trigger allowance really does punch a couple of hundred metres into
        // it. What matters is that it stays low.
        const top = thermalTop(inverted, 3000);
        ok(top !== null && top < 900, `capped low, got ${top}m`);
    });

    it('finds nothing under a strong inversion whatever the trigger', () => {
        equal(thermalTop([{elevation: 500, temp: 10}, {elevation: 700, temp: 25}], 3000), null);
    });

    it('needs two levels to say anything', () => {
        equal(thermalTop([{elevation: 500, temp: 30}], 3000), null);
    });

    it('stops lower when the trigger allowance is smaller', () => {
        // A profile cooling slightly slower than the dry adiabat, so the top is
        // set by how much warmer the bubble starts.
        const marginal = [{elevation: 500, temp: 20}, {elevation: 3000, temp: 20 - DRY_ADIABAT * 2500 + 5}];

        const generous = thermalTop(marginal, 3000, {trigger: 4});
        const mean = thermalTop(marginal, 3000, {trigger: 1});

        ok(generous > mean, `${generous} should beat ${mean}`);
    });

    it('reports nothing rather than a metre of lift', () => {
        // Neutral: the parcel is never buoyant, which used to return the ground
        // itself as a "thermal top".
        const neutral = [
            {elevation: 500, temp: 20},
            {elevation: 1500, temp: 20 - DRY_ADIABAT * 1000}
        ];

        equal(thermalTop(neutral, 3000, {trigger: 0}), null);
    });
});

describe('how fast a thermal climbs', () => {
    it('is nothing without heat going into the air', () => {
        equal(updraft(1500, 0, 25), 0);
    });

    it('is nothing without depth', () => {
        equal(updraft(0, 300, 25), 0);
    });

    it('is a believable climb rate on a good day', () => {
        const rate = updraft(2000, 300, 28);
        ok(rate > 1 && rate < 5, `got ${rate} m/s`);
    });

    it('climbs faster through a deeper layer', () => {
        ok(updraft(2000, 300, 25) > updraft(800, 300, 25));
    });

    it('climbs faster under a stronger heat flux', () => {
        ok(updraft(1500, 400, 25) > updraft(1500, 120, 25));
    });

    it('climbs faster in the thinner air up a mountain', () => {
        // Same heat, same layer: less air to lift means it goes up quicker.
        ok(updraft(1500, 300, 25, 2000) > updraft(1500, 300, 25, 0));
    });
});

describe('turning sunlight into heat', () => {
    it('uses the constant share when nothing better is known', () => {
        equal(heatFlux(800), HEAT_FRACTION * 800);
    });

    it('uses the share it is given when one is', () => {
        equal(heatFlux(800, 0.5), 400);
    });

    it('has nothing to convert in the dark', () => {
        equal(heatFlux(0), null);
        equal(heatFlux(0, 0.5), null);
    });
});

describe('the height a wing can still climb to', () => {
    it('sits above the strongest part of the thermal and below the top', () => {
        const top = climbTop(3000, 300, 0.8);
        const depth = 3000 - 300;

        // The profile peaks a third of the way up and is still going at the top
        // of the layer, so a wing runs out of climb somewhere between them.
        ok(top > 300 + 0.3125 * depth, `${top} should be above the peak`);
        ok(top < 3000, `${top} should be below the top of the layer`);
    });

    it('is higher on a stronger day', () => {
        ok(climbTop(3000, 300, 0.8) > climbTop(3000, 300, 0.6));
    });

    it('reaches the top of the layer when the whole of it beats the wing', () => {
        // The climb only falls to 0.8 of the layer mean at the very top, so any
        // day with a mean much past a metre a second is climbable all the way —
        // and it is then cloudbase, not the air, that ends the climb.
        // Within the search tolerance of the top, which is as close as a
        // bisection gets to an answer sitting on the edge of its range.
        close(climbTop(3000, 300, 3), 3000, 10);
    });

    it('is nothing when the air never beats the glider', () => {
        equal(climbTop(3000, 300, 0.2), null, 'a mean climb well under the sink rate');
        equal(climbTop(3000, 300, 0), null);
    });

    it('is nothing when there is no layer to climb through', () => {
        equal(climbTop(320, 300, 3), null);
    });

    it('gives way to a heavier wing', () => {
        const light = climbTop(3000, 300, 0.8, {sink: 0.8});
        const heavy = climbTop(3000, 300, 0.8, {sink: 1.5});

        ok(heavy < light, 'a faster sink rate runs out of climb lower down');
    });

    it('uses the same sink rate the Canadian RASP does', () => {
        equal(GLIDER_SINK, 1.0);
        equal(climbTop(3000, 300, 0.8), climbTop(3000, 300, 0.8, {sink: GLIDER_SINK}));
    });
});

describe('building the windgram', () => {
    it('has nothing to draw without a station', () => {
        equal(buildWindgram([]), null);
    });

    it('ignores a station that logged nothing', () => {
        const model = buildWindgram([
            ...real(),
            {station: {key: 'dark', shortName: 'Dark'}, elevationFeet: 9000, day: null}
        ]);

        equal(model.stations.length, 3);
    });

    it('ranks the stations by height, not by configuration order', () => {
        const heights = buildWindgram(real()).stations.map(station => station.elevationFeet);
        equal(heights, [1624, 3466, 5453]);
    });

    it('converts the reported feet into metres for the drawing', () => {
        const model = buildWindgram(real());
        close(model.stations[0].elevation, 1624 * FEET, 1e-6);
    });

    it('runs from an hour before sunrise to an hour after sunset', () => {
        const model = buildWindgram(real());
        const {sunrise, sunset} = sunTimes(model.dayStart + 12 * 3600000,
            model.latitude, model.longitude);

        const HALF = 30 * 60 * 1000;

        // Both ends land on a half hour of the site's own clock.
        [model.dayStart, model.lastTime].forEach(edge =>
            equal((edge + model.offset) % HALF, 0, `${edge} is on a half hour`));

        close(model.dayStart, sunrise - 3600000, HALF / 2 + 1);
        close(model.lastTime, sunset + 3600000, HALF / 2 + 1);
        ok(model.lastTime - model.dayStart < 86400000, 'and it is still one day');
    });

    it('divides the day into columns of the configured width', () => {
        const model = buildWindgram(real());
        const [first, second] = model.columns;

        if (second) close(second.time - first.time, COLUMN_MS, 1);
    });

    it('releases thermals from the site launch, not the valley floor', () => {
        // The bug this pins: with the valley station as the surface, a morning
        // inversion capped every thermal and the lift strip collapsed the
        // moment that station came online.
        equal(buildWindgram(real()).launch.shortName, 'Coopers');
    });

    it('falls back to the lowest station when none is marked default', () => {
        const plain = real().map(entry => ({...entry, station: {...entry.station, isDefault: false}}));
        equal(buildWindgram(plain).launch.shortName, 'FFP');
    });
});

describe('the barometer strip', () => {
    it('takes every reading from one station, whatever the others report', () => {
        // Two stations reporting pressure on utterly different scales — one
        // absolute, one sea-level — which is exactly what the real stations do.
        // Mixing them drew a six kilopascal cliff.
        const entries = [
            {
                station: STATIONS.ILUMBY8,
                elevationFeet: 1000,
                latitude: 50.28,
                longitude: -118.98,
                day: staged({hours: 2, temp: 15, pressure: (index) => index < 6 ? null : 95.9})
            },
            {
                station: STATIONS.IVERNO71,
                elevationFeet: 5000,
                latitude: 50.28,
                longitude: -118.98,
                day: staged({hours: 6, temp: 5, pressure: 101.7})
            }
        ];

        const readings = buildWindgram(entries).columns
            .map(column => column.pressure)
            .filter(value => value !== null);

        ok(readings.length, 'something was charted');

        const spread = Math.max(...readings) - Math.min(...readings);
        ok(spread < 1, `one barometer, so no cliff — spread was ${spread.toFixed(2)} kPa`);
    });
});

describe('cloud in the profile', () => {
    it('never hatches above the highest station', () => {
        // Temperature and dew point are each continued at their own gradient
        // above the top station, and two lines with different slopes always
        // meet. That used to hatch a confident cloud layer into air nothing had
        // measured.
        const model = buildWindgram(profile(
            {temp: 25, dewpt: 0},
            {temp: 5, dewpt: 4}
        ));

        const top = model.stations.at(-1).elevation;

        model.columns.forEach(column => {
            column.clouds.forEach(cloudBand => {
                ok(cloudBand.to <= top + 1, `hatched to ${Math.round(cloudBand.to)}m, above ${Math.round(top)}m`);
            });
        });
    });

    it('hatches air that really is at its dew point', () => {
        const model = buildWindgram(profile(
            {temp: 12, dewpt: 11.9},
            {temp: 11.8, dewpt: 11.75}
        ));

        ok(model.columns.some(column => column.clouds.length), 'saturated air is marked');
    });

    it('leaves dry air alone', () => {
        const model = buildWindgram(profile({temp: 25, dewpt: -5}, {temp: 12, dewpt: -8}));
        ok(model.columns.every(column => !column.clouds.length));
    });
});

describe('thermals through the night', () => {
    it('reports none in the dark, however unstable the air', () => {
        // Overnight air really can be steeply unstable. Nothing is heating the
        // ground, so nothing goes up, and the drawing used to claim a
        // two-kilometre thermal top at three in the morning.
        const model = buildWindgram(profile({temp: 30, solar: 0}, {temp: 0}));

        ok(model.columns.every(column => column.thermalTop === null), 'no thermal without sun');
        ok(model.columns.every(column => column.lift === null), 'and so no lift');
    });

    it('reports a thermal once the sun is on the ground', () => {
        const model = buildWindgram(profile({temp: 30, solar: 700}, {temp: 0}));

        ok(model.columns.some(column => column.thermalTop !== null), 'a thermal is found');
        ok(model.columns.some(column => column.lift > 0), 'and it climbs');
    });

    it('keeps the thermal under the ceiling', () => {
        const model = buildWindgram(profile({temp: 40, solar: 900}, {temp: -20}));

        model.columns.forEach(column => {
            if (column.thermalTop !== null) ok(column.thermalTop <= model.ceiling);
        });
    });
});

describe('smoothing the profile', () => {
    it('does not let one twitchy reading recolour a column', () => {
        // A single five-minute bucket four degrees out would otherwise swing the
        // lapse rate across several stability bands and stripe the drawing.
        const steady = profile({temp: 20}, {temp: 10});
        const spiked = profile({temp: index => index === 12 ? 24 : 20}, {temp: 10});

        // The column the spike actually lands in, rather than a fixed index:
        // the drawing's window starts before sunrise, so which column that is
        // depends on the time of year.
        const spikeAt = MIDNIGHT + 6 * 3600000 + 12 * FIVE;

        const rateOf = model => model.columns.reduce((best, column) =>
            Math.abs(column.time - spikeAt) < Math.abs(best.time - spikeAt) ? column : best,
        model.columns[0])?.segments[0]?.rate ?? null;

        const before = rateOf(buildWindgram(steady));
        const after = rateOf(buildWindgram(spiked));

        ok(before !== null && after !== null, 'both drew a slab');
        ok(Math.abs(after - before) < 0.5,
            `a single spike moved the lapse rate by ${Math.abs(after - before).toFixed(2)} ºC/1000 ft`);
    });
});

describe('showing and hiding a piece of a drawing', () => {
    /**
     * @returns {SVGElement} A detached SVG group, hidden
     */
    const group = () => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('hidden', '');
        return g;
    };

    it('is not something the hidden property can do to SVG', () => {
        // The reason this module exists. `hidden` belongs to HTMLElement, so
        // assigning it on an SVG node sets a stray property and leaves the
        // attribute — and the element — exactly as they were. It fails without
        // a word, which is how the crosshair came to sit visible at the left
        // edge of every day chart.
        const g = group();
        g.hidden = false;

        ok(g.hasAttribute('hidden'), 'the attribute survived the assignment');
    });

    it('shows an SVG element', () => {
        const g = group();
        reveal(g, true);
        ok(!g.hasAttribute('hidden'));
    });

    it('hides an SVG element', () => {
        const g = group();
        reveal(g, true);
        reveal(g, false);
        ok(g.hasAttribute('hidden'));
    });

    it('works on ordinary HTML too', () => {
        const div = document.createElement('div');
        reveal(div, false);
        ok(div.hasAttribute('hidden'));
        reveal(div, true);
        ok(!div.hasAttribute('hidden'));
    });

    it('does not fall over when there is nothing to show', () => {
        reveal(null, true);
        reveal(undefined, false);
    });
});

describe('drawing it', () => {

    it('says so rather than drawing an empty frame with nothing to draw', () => {
        ok(draw(null).includes('chart-empty'));
    });

    it('draws a strip for every one configured', () => {
        const markup = draw(buildWindgram(real()));
        STRIPS.forEach(strip => ok(markup.includes(strip.label), `${strip.label} is drawn`));
    });

    it('names every station down the side', () => {
        const markup = draw(buildWindgram(real()));
        ['FFP', 'Coopers', 'SilverStar'].forEach(name =>
            ok(markup.includes(name), `${name} is labelled`));
    });

    it('gives both scales, metres and feet', () => {
        const markup = draw(buildWindgram(real()));
        ok(markup.includes('m</text>'), 'metres');
        ok(markup.includes("'</text>"), 'feet');
    });

    it('draws barbs', () => {
        ok(draw(buildWindgram(real())).includes('windgram-barb'));
    });

    it('gives every barb a target big enough to tap', () => {
        const markup = draw(buildWindgram(real()));
        const hits = markup.match(/class="windgram-barb-hit"/g) ?? [];
        const barbs = markup.match(/class="windgram-barb"/g) ?? [];
        const calms = markup.match(/class="windgram-calm"/g) ?? [];

        // One target per mark, and the calms are drawn as two rings each.
        equal(hits.length, barbs.length + calms.length / 2);
        ok(hits.length > 0, 'there are some');
    });

    it('hangs the reading behind each barb off its target', () => {
        const markup = draw(buildWindgram(real()));
        const hit = markup.match(/<circle class="windgram-barb-hit"[^>]*>/)[0];

        ok(/data-speed="[\d.]+"/.test(hit), `speed: ${hit}`);
        ok(/data-point="[A-Z]{1,3}"/.test(hit), `compass point: ${hit}`);
        ok(/data-station="[^"]+"/.test(hit), `station: ${hit}`);
        ok(/aria-label="[^"]*km\/h/.test(hit), `and it is announced: ${hit}`);
    });

    it('names the barb that was tapped', () => {
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const windgram = new Windgram(host);
        windgram.setModel(buildWindgram(real()));

        const hit = host.querySelector('.windgram-barb-hit');
        windgram.showTip(hit);

        const tip = host.querySelector('.windgram-tip');

        ok(!tip.hasAttribute('hidden'), 'the popup is showing');
        equal(tip.querySelector('.windgram-tip-point').textContent, hit.dataset.point);
        equal(tip.querySelector('.windgram-tip-speed').textContent, `${hit.dataset.speed} km/h`);

        windgram.hideTip();
        ok(tip.hasAttribute('hidden'), 'and it goes away again');

        windgram.destroy();
        host.remove();
    });

    it('keeps the popup inside the drawing at the right-hand edge', () => {
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const windgram = new Windgram(host);
        windgram.setModel(buildWindgram(real()));

        const hits = [...host.querySelectorAll('.windgram-barb-hit')];
        const last = hits.reduce((best, hit) =>
            Number(hit.getAttribute('cx')) > Number(best.getAttribute('cx')) ? hit : best, hits[0]);

        // Moved to the edge rather than trusting the last reading to be there.
        // The window runs to an hour past sunset, so on any afternoon the
        // right-hand end of the drawing is hours of empty frame.
        last.setAttribute('cx', String(windgram.right - 4));

        windgram.showTip(last);

        const box = host.querySelector('.windgram-tip-box');
        const left = Number(box.getAttribute('x'));

        ok(left < Number(last.getAttribute('cx')), 'folded back over the barb');
        ok(left > 0, 'and still on the drawing');

        windgram.destroy();
        host.remove();
    });

    it('marks the air above the top station as extrapolated', () => {
        ok(draw(buildWindgram(real())).includes('windgram-extrapolated-edge'));
    });

    it('admits which numbers are worked out rather than measured', () => {
        const markup = draw(buildWindgram(real()));
        ok(markup.includes('extrapolated'), 'says the top of the drawing is a continuation');
        ok(/[Ss]hade is measured/.test(markup), 'says shade came from a sensor');
        ok(/[Cc]loud is modelled/.test(markup), 'and that cloud did not');
    });

    it('draws nothing above the ceiling it was given', () => {
        const model = buildWindgram(real());
        equal(model.ceiling, Math.max(CEILING, 5453 * FEET + 500));
    });

    it('wraps its footnotes rather than running them off a narrow chart', () => {
        const model = buildWindgram(real());

        const host = document.createElement('div');
        host.style.cssText = 'width:360px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const windgram = new Windgram(host);
        windgram.setModel(model);

        const longest = Math.max(...windgram.notes.map(line => line.length));
        ok(windgram.notes.length > 3, 'broken into several lines');
        ok(longest < 90, `longest line was ${longest} characters`);

        windgram.destroy();
        host.remove();
    });

    it('survives a hidden panel with no width to draw into', () => {
        const host = document.createElement('div');
        host.style.cssText = 'width:0;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const windgram = new Windgram(host);
        windgram.setModel(buildWindgram(real()));

        equal(host.innerHTML, '');

        windgram.destroy();
        host.remove();
    });
});

/**
 * A modelled column of air above the stations, aligned to the staged day.
 *
 * Only ever heights above the top station: the point of the thing is that
 * measurements win everywhere a station is standing.
 *
 * @param {Object} [options] - The levels, the cloud, and the share of sun that becomes heat
 * @returns {Object} A model in the shape the sounding service hands over
 */
function sky({levels = [[1800, 8], [2400, 2], [3200, -6]], cloud = 40, share = 0.5,
    from = 6, hours = 8} = {}) {
    // Over the same hours the staged stations report, so the modelled air is
    // actually there for the columns the assertions look at.
    const times = Array.from({length: hours + 1},
        (unused, index) => MIDNIGHT + (from + index) * 3600000);

    return {
        times,
        levels: levels.map(([height, temp], index) => ({
            pressure: 800 - index * 50,
            heights: times.map(() => height),
            temps: times.map(() => temp)
        })),
        cloud: times.map(() => cloud),
        share: times.map(() => share)
    };
}

// A hot valley under a cold hill: unstable enough that a parcel leaves the
// measured column and keeps going, which is the only way to see what the
// modelled air does to it.
const SOARING = () => profile({temp: 30, solar: 800}, {temp: 10});

/**
 * The column at the middle of a staged day.
 * @param {Object} model - A built windgram
 * @returns {Object} One column
 */
function midday(model) {
    // The middle of the part that was logged, rather than the middle of the
    // frame: the frame now runs from before sunrise to after sunset, and a
    // staged day fills only some of it.
    const charted = model.columns.filter(column => column.levels.length);

    return charted[Math.floor(charted.length / 2)] ?? model.columns[0];
}

describe('the air above the top station', () => {
    it('is a continuation of one gradient when nothing else is offered', () => {
        const model = buildWindgram(SOARING());

        equal(model.modelledAloft, false);
        ok(midday(model).above, 'the extrapolated slab is still drawn');
    });

    it('is the model, when there is one', () => {
        const model = buildWindgram(SOARING(), sky());
        const column = midday(model);

        equal(model.modelledAloft, true);
        equal(column.above, null, 'nothing left to extrapolate');
        ok(column.segments.some(segment => segment.modelled), 'and the air up there says where it came from');
    });

    it('leaves the measured column alone', () => {
        const model = buildWindgram(SOARING(), sky());
        const column = midday(model);
        const top = 5000 * FEET;

        // Every station reading is still in the profile, and nothing modelled
        // has been slipped in underneath the top station.
        equal(column.levels.length, 2, 'both stations');
        ok(column.profile.filter(level => level.modelled).every(level => level.elevation > top),
            'the model only ever speaks above the last thermometer');
    });

    it('draws the modelled air knocked back, the way the guess was', () => {
        const markup = draw(buildWindgram(SOARING(), sky()));
        ok(markup.includes('windgram-extrapolated-edge'), 'the line where measurement stops is still drawn');
    });

    it('says in the footnotes which of the two it is', () => {
        ok(/HRDPS/.test(draw(buildWindgram(SOARING(), sky()))), 'names the model when there is one');
        ok(/extrapolated from the gradient/.test(draw(buildWindgram(SOARING()))), 'and admits the guess when there is not');
    });
});

describe('a thermal climbing into modelled air', () => {
    it('keeps going through air the model says is unstable', () => {
        const column = midday(buildWindgram(SOARING(), sky()));
        ok(column.thermalTop > 5000 * FEET, 'the top is above the top station');
    });

    it('stops at an inversion the model knows about and the stations cannot', () => {
        const cold = midday(buildWindgram(SOARING(), sky())).thermalTop;
        // Same hillside, same sun — but warm air sitting on top of it.
        const capped = midday(buildWindgram(SOARING(), sky({levels: [[1800, 25], [2400, 26], [3200, 24]]}))).thermalTop;

        ok(capped < cold, `capped ${capped} should be under ${cold}`);
        ok(capped > 5000 * FEET, 'though still above the stations');
    });
});

describe('how high a wing actually climbs', () => {
    it('is lower than where the bubble stops', () => {
        const column = midday(buildWindgram(SOARING(), sky()));

        ok(column.climbTop !== null, 'there is a usable climb');
        ok(column.climbTop < column.thermalTop, `${column.climbTop} should be under ${column.thermalTop}`);
    });

    it('is nothing at all on a day that never climbs faster than a glider sinks', () => {
        // Barely any sun, and almost none of it becoming heat, so the layer mean
        // never gets anywhere near the wing.
        const weak = buildWindgram(profile({temp: 30, solar: 70}, {temp: 10}), sky({share: 0.01}));
        equal(midday(weak).climbTop, null);
    });

    it('stops at cloudbase when there is cloud in the way', () => {
        const column = midday(buildWindgram(
            profile({temp: 30, dewpt: 26, solar: 800}, {temp: 10, dewpt: 6}), sky()));

        equal(Math.round(column.climbTop), Math.round(column.cloudBase),
            'the climb ends where the cloud starts');
    });

    it('is drawn under the thermal top, dashed', () => {
        ok(draw(buildWindgram(SOARING(), sky())).includes('windgram-climb-line'));
    });

    it('is named in the footnotes, since two lines need telling apart', () => {
        ok(/dashed line/.test(draw(buildWindgram(SOARING(), sky()))));
    });
});

describe('where the strength of the day comes from', () => {
    it('is the station\'s own sunlight, not the model\'s', () => {
        const bright = midday(buildWindgram(profile({temp: 30, solar: 900}, {temp: 10}), sky())).lift;
        const smoky = midday(buildWindgram(profile({temp: 30, solar: 300}, {temp: 10}), sky())).lift;

        ok(bright > smoky, `${bright} should beat ${smoky}`);
    });

    it('takes only the share of it that becomes heat from the model', () => {
        const dry = midday(buildWindgram(SOARING(), sky({share: 0.6}))).lift;
        const wet = midday(buildWindgram(SOARING(), sky({share: 0.1}))).lift;

        ok(dry > wet, 'ground that heats the air makes a stronger day than ground that evaporates');
    });

    it('falls back to the constant share when the model does not say', () => {
        const column = midday(buildWindgram(SOARING(), sky({share: null})));
        ok(column.lift > 0, 'still a climb rate');
    });
});

describe('the cloud strip', () => {
    it('carries the modelled cover', () => {
        equal(midday(buildWindgram(SOARING(), sky({cloud: 65}))).cloud, 65);
    });

    it('is empty rather than zero when nothing is modelled', () => {
        equal(midday(buildWindgram(SOARING())).cloud, null);
    });

    it('is drawn beside shade rather than instead of it', () => {
        const markup = draw(buildWindgram(SOARING(), sky()));
        ok(markup.includes('>Cloud<'), 'the modelled row');
        ok(markup.includes('>Shade<'), 'and the measured one');
    });
});


describe('when the sun comes up and goes down', () => {
    // Vernon, and the two ends of its year.
    const LATITUDE = 50.3;
    const LONGITUDE = -119;
    const AUGUST = Date.UTC(2026, 7, 11, 19);
    const SOLSTICE = Date.UTC(2026, 5, 21, 19);
    const MIDWINTER = Date.UTC(2025, 11, 21, 20);

    const minutes = ms => ms / 60000;
    const daylight = at => {
        const {sunrise, sunset} = sunTimes(at, LATITUDE, LONGITUDE);
        return sunset - sunrise;
    };

    it('agrees with a full solar algorithm to within a couple of minutes', () => {
        // Open-Meteo's own published times for this day and place, which come
        // from a complete algorithm rather than this one's series. Checked
        // against a year of dates when this was written: worst case under two
        // minutes, which is well inside what the terrain does to a real sunset.
        const {sunrise, sunset} = sunTimes(AUGUST, LATITUDE, LONGITUDE);

        // The sunset of an August evening in the Okanagan falls on the next
        // day in UTC, which is exactly the sort of thing this has to get right.
        close(minutes(sunrise), minutes(Date.UTC(2026, 7, 11, 12, 39)), 3);
        close(minutes(sunset), minutes(Date.UTC(2026, 7, 12, 3, 22)), 3);
    });

    it('puts the sun up before noon and down after it', () => {
        const {sunrise, sunset} = sunTimes(AUGUST, LATITUDE, LONGITUDE);
        ok(sunrise < sunset, 'and in that order');
        ok(sunset - sunrise > 12 * 3600000, 'a long August day');
    });

    it('gives a longer day at midsummer than at midwinter', () => {
        ok(daylight(SOLSTICE) > daylight(MIDWINTER));
        ok(minutes(daylight(SOLSTICE)) > 15 * 60, 'nearly sixteen hours in June');
        ok(minutes(daylight(MIDWINTER)) < 9 * 60, 'and under nine in December');
    });

    it('is roughly symmetric about the middle of the day', () => {
        const {sunrise, sunset} = sunTimes(AUGUST, LATITUDE, LONGITUDE);
        const noon = (sunrise + sunset) / 2;

        // Solar noon at this longitude, which is nearly half an hour off the
        // clock noon its timezone keeps.
        const solarNoon = Date.UTC(2026, 7, 11, 20, 0);
        close(minutes(noon), minutes(solarNoon), 20);
    });

    it('names no time where there is none to name', () => {
        // Svalbard, either side of its year.
        equal(sunTimes(Date.UTC(2026, 5, 21, 12), 78, 15).up, true, 'the midnight sun');
        equal(sunTimes(Date.UTC(2026, 11, 21, 12), 78, 15).up, false, 'and the polar night');

        [sunTimes(Date.UTC(2026, 5, 21, 12), 78, 15), sunTimes(Date.UTC(2026, 11, 21, 12), 78, 15)]
            .forEach(day => {
                equal(day.sunrise, null);
                equal(day.sunset, null);
            });
    });

    it('says nothing at all without somewhere to stand', () => {
        const nowhere = sunTimes(AUGUST, undefined, undefined);

        equal(nowhere.sunrise, null);
        equal(nowhere.sunset, null);
        equal(nowhere.up, null, 'and does not claim it is a polar day either');
    });

    it('answers for the day it was asked about, wherever that day starts', () => {
        // Local noon on either side of UTC midnight still has to name the same
        // sunrise, which is why the panel asks about noon rather than midnight.
        const {sunrise} = sunTimes(AUGUST, LATITUDE, LONGITUDE);
        const later = sunTimes(AUGUST + 3 * 3600000, LATITUDE, LONGITUDE);

        close(minutes(sunrise), minutes(later.sunrise), 1);
    });
});

describe('marking the day on the drawings', () => {
    it('rules sunrise and sunset down the chart', () => {
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const chart = new Chart(host);
        const readings = staged({hours: 12, temp: 15, solar: 400});

        chart.setCatalogue(SERIES);
        chart.setSun(sunTimes(MIDNIGHT + 12 * 3600000, 50.3, -119));
        chart.setDay(readings);
        chart.setView(['temp'], 'split');

        const markup = host.innerHTML;
        chart.destroy();
        host.remove();

        ok(markup.includes('chart-sun-line'), 'the lines are drawn');
        ok(markup.includes('>Sunrise<'), 'and named');
        ok(markup.includes('>Sunset<'));
    });

    it('marks nothing on a chart that was never told where the sun is', () => {
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const chart = new Chart(host);
        chart.setCatalogue(SERIES);
        chart.setDay(staged({hours: 12, temp: 15}));
        chart.setView(['temp'], 'split');

        const markup = host.innerHTML;
        chart.destroy();
        host.remove();

        ok(!markup.includes('chart-sun-line'), 'no marks rather than marks at midnight');
    });

    it('marks both ends of the day, which the window is built around', () => {
        // The frame runs an hour either side of the sun, so both marks fall
        // inside it by construction rather than by luck of the staging.
        const markup = draw(buildWindgram(SOARING(), sky()));

        ok(markup.includes('>Sunrise<'), 'sunrise is marked');
        ok(markup.includes('>Sunset<'), 'and so is sunset');
    });
});
