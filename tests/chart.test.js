import {describe, it, equal, ok, fixture} from './runner.js';
import {SERIES, LAPSE_COLOURS} from '../scripts/config/series.js';
import {READOUTS} from '../scripts/config/readouts.js';
import {History} from '../scripts/history.js';
import {Chart} from '../scripts/chart.js';
import {lapsePairs, lapseColumn} from '../scripts/lapse-series.js';
import {pointAt} from '../scripts/config/compass.js';
import weather from '../scripts/weather.js';

/**
 * The day, and the drawing of it.
 *
 * The chart is built from strings of SVG, so these check what it produced
 * rather than how it looks: the right number of panels, an axis that does not
 * dip below zero for rain, a lapse panel drawn upside down.
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

/**
 * Draws a chart offscreen and hands back its markup.
 * @param {Object} options - day, catalogue, keys and mode
 * @returns {string} The SVG markup
 */
function draw({day, catalogue = SERIES, keys, mode = 'split', width = 900}) {
    const host = document.createElement('div');
    host.style.cssText = `width:${width}px;position:absolute;left:-9999px;top:0`;
    document.body.appendChild(host);

    const chart = new Chart(host);
    chart.setCatalogue(catalogue);
    chart.setDay(day);
    chart.setView(keys, mode);

    const markup = host.innerHTML;
    chart.destroy();
    host.remove();

    return markup;
}

describe('the series catalogue', () => {
    it('gives every measurement a unique key', () => {
        equal(new Set(SERIES.map(s => s.key)).size, SERIES.length);
    });

    it('gives every measurement a colour and a label', () => {
        SERIES.forEach(series => {
            ok(/^#[0-9a-f]{6}$/i.test(series.colour), `${series.key} has a colour`);
            ok(series.label?.length, `${series.key} has a label`);
            ok(typeof series.read === 'function', `${series.key} knows where to find itself`);
        });
    });

    it('floors the measurements that cannot go negative', () => {
        // Rain, sunlight, humidity and wind speed have no meaning below zero,
        // and an axis that pads into negative numbers invents readings.
        ['windSpeed', 'windGust', 'humidity', 'solar', 'uv', 'precipRate', 'precipTotal']
            .forEach(key => equal(SERIES.find(s => s.key === key).floor, 0, key));
    });

    it('leaves the ones that can go negative unfloored', () => {
        ['temp', 'dewpt'].forEach(key =>
            equal(SERIES.find(s => s.key === key).floor, undefined, key));
    });

    it('draws the readings that are moments, not trends, as dots', () => {
        equal(SERIES.find(s => s.key === 'windGust').shape, 'dots');
        equal(SERIES.find(s => s.key === 'windDir').shape, 'dots');
    });

    it('pins wind direction to the whole compass', () => {
        equal(SERIES.find(s => s.key === 'windDir').domain, [0, 360]);
    });
});

describe('reading a day out of the API', () => {
    it('keeps a bucket for every reading logged', () => {
        equal(days.ILUMBY7.times.length, days.ILUMBY7.values.temp.length);
    });

    it('anchors the axis to midnight, not to the first reading', () => {
        // A station that came online at eight has to line up with one that has
        // been running since midnight.
        equal(days.ILUMBY7.dayEnd - days.ILUMBY7.dayStart, 86400000);
        ok(days.ILUMBY7.times[0] >= days.ILUMBY7.dayStart);
        ok(days.ILUMBY7.times.at(-1) <= days.ILUMBY7.dayEnd);
    });

    it('drops a measurement the station never reports', () => {
        // Silver Star has no UV or sunlight sensor, so neither should be
        // offered as something to plot.
        ok(!('uv' in days.IVERNO71.values), 'no UV column');
        ok(!('solar' in days.IVERNO71.values), 'no solar column');
        ok('temp' in days.IVERNO71.values, 'temperature still there');
    });

    it('offers pressure only where there is a barometer', () => {
        ok(!('pressure' in days.ILUMBY7.values));
        ok('pressure' in days.IVERNO71.values);
    });
});

describe('drawing the day', () => {
    it('says so when there is nothing logged', () => {
        ok(draw({day: null, keys: ['temp']}).includes('No readings logged'));
    });

    it('asks for a measurement when none is chosen', () => {
        ok(draw({day: days.ILUMBY7, keys: []}).includes('Pick a measurement'));
    });

    it('gives each group its own panel when stacked', () => {
        // Temperature and dew point share a panel; wind and its gusts share
        // another. Three of the four are trends and get a line; the gusts are
        // moments and get dots.
        const markup = draw({day: days.ILUMBY7, keys: ['temp', 'dewpt', 'windSpeed', 'windGust']});
        equal((markup.match(/class="chart-line"/g) ?? []).length, 3, 'three lines');
        equal((markup.match(/class="chart-dots"/g) ?? []).length, 1, 'gusts as dots');
        equal((markup.match(/class="chart-key-group"/g) ?? []).length, 2, 'two panels, two keys');
    });

    it('puts everything on one panel when overlaid', () => {
        const stacked = draw({day: days.ILUMBY7, keys: ['temp', 'windSpeed'], mode: 'split'});
        const overlaid = draw({day: days.ILUMBY7, keys: ['temp', 'windSpeed'], mode: 'combined'});
        ok(overlaid.length < stacked.length, 'one panel is less markup than two');
    });

    it('states fill and stroke on the path itself', () => {
        // An unstyled SVG path is filled black, which turned a day's
        // temperature into a solid wedge when the stylesheet was stale.
        const markup = draw({day: days.ILUMBY7, keys: ['temp']});
        ok(markup.includes('fill="none"'));
        ok(markup.includes('stroke="#d92c2c"'));
    });

    it('never draws a rain axis below zero', () => {
        const markup = draw({day: days.ILUMBY7, keys: ['precipRate', 'precipTotal']});
        const labels = [...markup.matchAll(/class="chart-axis"[^>]*>(-?[\d.]+)</g)].map(m => Number(m[1]));
        ok(labels.length, 'there are axis labels');
        ok(labels.every(value => value >= 0), `no negative rain: ${labels}`);
    });

    it('draws nothing at all in a panel with no width', () => {
        // A chart in a hidden tab has no width; it is drawn when it is shown.
        const host = document.createElement('div');
        host.style.cssText = 'width:0;position:absolute;left:-9999px';
        document.body.appendChild(host);
        const chart = new Chart(host);
        chart.setDay(days.ILUMBY7);
        chart.setView(['temp'], 'split');
        equal(host.innerHTML, '');
        chart.destroy();
        host.remove();
    });

    it('breaks the line over a gap instead of bridging it', () => {
        const gapped = {
            ...days.ILUMBY7,
            values: {...days.ILUMBY7.values, temp: days.ILUMBY7.values.temp.map((v, i) => i > 5 && i < 10 ? null : v)}
        };

        const path = draw({day: gapped, keys: ['temp']}).match(/ d="([^"]+)"/)[1];
        // A second "move to" is the gap: an outage should look like an outage.
        ok((path.match(/M/g) ?? []).length >= 2, 'the line restarts after the gap');
    });
});

describe('the wind arrows', () => {
    const arrows = markup => [...markup.matchAll(/class="chart-arrow"[\s\S]*?rotate\((-?[\d.]+)/g)]
        .map(match => Number(match[1]));

    it('draws a row above the direction panel', () => {
        const markup = draw({day: days.ILUMBY7, keys: ['windDir']});
        ok(markup.includes('class="chart-arrows"'));
        ok(arrows(markup).length > 5, 'a row, not a token arrow');
    });

    it('uses the same glyph as the wind tiles', () => {
        // Not a drawn triangle: the Material arrow, so the chart and the tile
        // above it show the same shape.
        ok(draw({day: days.ILUMBY7, keys: ['windDir']}).includes('>navigation</text>'));
    });

    it('points the way the air is going, not where it came from', () => {
        const first = days.ILUMBY7.values.windDir.find(value => value !== null);
        const drawn = arrows(draw({day: days.ILUMBY7, keys: ['windDir']}));
        ok(drawn.every(angle => angle >= 180 && angle <= 540), `turned by 180: ${drawn.slice(0, 3)}`);
        ok(Number.isFinite(first));
    });

    it('turns each arrow about its own middle', () => {
        // rotate(deg) alone spins the glyph around the origin and throws it off
        // the chart; it needs the centre naming.
        const markup = draw({day: days.ILUMBY7, keys: ['windDir']});
        ok(/rotate\(-?[\d.]+ [\d.]+ [\d.]+\)/.test(markup));
    });

    it('comes along when direction is overlaid with everything else', () => {
        const markup = draw({day: days.ILUMBY7, keys: ['temp', 'windSpeed', 'windDir'], mode: 'combined'});
        ok(markup.includes('class="chart-arrows"'));
    });

    it('stays away when direction is not being shown', () => {
        ok(!draw({day: days.ILUMBY7, keys: ['temp', 'windSpeed']}).includes('chart-arrows'));
        ok(!draw({day: days.ILUMBY7, keys: ['temp'], mode: 'combined'}).includes('chart-arrows'));
    });

    it('thins out on a narrow screen rather than overlapping', () => {
        const wide = arrows(draw({day: days.ILUMBY7, keys: ['windDir'], width: 900})).length;
        const narrow = arrows(draw({day: days.ILUMBY7, keys: ['windDir'], width: 380})).length;
        ok(narrow < wide, `${narrow} on a phone against ${wide} on a desktop`);
        ok(narrow >= 2, 'but never down to nothing');
    });

    it('leaves a gap where the station logged nothing', () => {
        // Half a day of readings should give roughly half a row of arrows.
        const half = {
            ...days.ILUMBY7,
            times: days.ILUMBY7.times.slice(0, 8),
            values: Object.fromEntries(
                Object.entries(days.ILUMBY7.values).map(([key, column]) => [key, column.slice(0, 8)]))
        };

        const partial = arrows(draw({day: half, keys: ['windDir']})).length;
        const full = arrows(draw({day: days.ILUMBY7, keys: ['windDir']})).length;
        ok(partial < full, `${partial} arrows for a partial day against ${full}`);
    });

    it('makes room for itself instead of drawing over the panel', () => {
        const withArrows = draw({day: days.ILUMBY7, keys: ['windDir']});
        const without = draw({day: days.ILUMBY7, keys: ['humidity']});

        const height = markup => Number(markup.match(/height="(\d+)"/)[1]);
        ok(height(withArrows) > height(without), 'the chart grew by the band');

        const arrowY = Number(withArrows.match(/class="chart-arrow" x="[\d.]+" y="([\d.]+)"/)[1]);
        const panelTop = Number(withArrows.match(/class="chart-band"[^>]*y="([\d.]+)"/)[1]);
        ok(arrowY < panelTop, `arrows at ${arrowY} sit above the panel at ${panelTop}`);
    });

    it('pushes the panels below it down by the same band', () => {
        // Direction leads, so humidity underneath has to move with it.
        const markup = draw({day: days.ILUMBY7, keys: ['windDir', 'humidity']});
        const tops = [...markup.matchAll(/class="chart-band"[^>]*y="([\d.]+)"/g)].map(m => Number(m[1]));
        const panels = [...new Set(tops)].sort((a, b) => a - b);

        equal(panels.length, 2, 'two panels');
        ok(panels[1] - panels[0] >= 104, 'the second clears the first');
    });

    it('draws nothing when the station reports no direction', () => {
        const noDirection = {
            ...days.ILUMBY7,
            values: {...days.ILUMBY7.values, windDir: undefined}
        };
        delete noDirection.values.windDir;

        ok(!draw({day: noDirection, keys: ['humidity']}).includes('chart-arrows'));
    });
});

describe('reading a moment off the chart', () => {
    /**
     * Puts the crosshair on one reading and hands back what it printed.
     * @param {string[]} keys - The measurements to show
     * @param {number} [index=4] - Which reading to land on
     * @returns {string[]} The readout labels
     */
    function readout(keys, index = 4) {
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const chart = new Chart(host);
        chart.setCatalogue(SERIES);
        chart.setDay(days.ILUMBY7);
        chart.setView(keys, 'split');
        chart.showReadout(index);

        const values = [...host.querySelectorAll('.chart-readout-value')].map(node => node.textContent);
        chart.destroy();
        host.remove();

        return values;
    }

    it('names the wind direction rather than giving a bearing', () => {
        // "224.0 º" has to be converted in the reader's head; "WSW" does not.
        const [text] = readout(['windDir']);
        equal(text, pointAt(days.ILUMBY7.values.windDir[4]).abbr);
        ok(/^[NSEW]{1,3}$/.test(text), `${text} is a compass point`);
    });

    it('does not print the degree sign on a direction any more', () => {
        ok(!readout(['windDir'])[0].includes('º'));
    });

    it('agrees with the compass down the side of the panel', () => {
        // A reading of 270 sits on the W gridline, so it must read W.
        const straightWest = {
            ...days.ILUMBY7,
            values: {...days.ILUMBY7.values, windDir: days.ILUMBY7.values.windDir.map(() => 270)}
        };

        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const chart = new Chart(host);
        chart.setCatalogue(SERIES);
        chart.setDay(straightWest);
        chart.setView(['windDir'], 'split');
        chart.showReadout(4);

        equal(host.querySelector('.chart-readout-value').textContent, 'W');
        chart.destroy();
        host.remove();
    });

    it('leaves every other measurement as a number and a unit', () => {
        const [temperature] = readout(['temp']);
        ok(/^[\d.-]+ ºC$/.test(temperature), `${temperature} is still a temperature`);

        const [rain] = readout(['precipTotal']);
        ok(/^[\d.]+ mm$/.test(rain), `${rain} is still a depth`);
    });

    it('keeps each measurement in its own words when several are shown', () => {
        const texts = readout(['windSpeed', 'windDir']);
        ok(texts.some(text => text.includes('km/h')), 'speed carries its unit');
        ok(texts.some(text => /^[NSEW]{1,3}$/.test(text)), 'direction does not');
    });

    it('prints the time it is reading', () => {
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;position:absolute;left:-9999px;top:0';
        document.body.appendChild(host);

        const chart = new Chart(host);
        chart.setCatalogue(SERIES);
        chart.setDay(days.ILUMBY7);
        chart.setView(['windDir'], 'split');
        chart.showReadout(4);

        ok(/\d/.test(host.querySelector('.chart-readout-time').textContent));
        chart.destroy();
        host.remove();
    });
});

describe('lapse rate over the day', () => {
    const entries = [
        {station: {shortName: 'Coopers'}, elevation: 3466, day: days.ILUMBY7},
        {station: {shortName: 'FFP'}, elevation: 1624, day: days.ILUMBY8},
        {station: {shortName: 'SilverStar'}, elevation: 5453, day: days.IVERNO71}
    ];

    it('builds one line per adjacent pair, highest first', () => {
        const pairs = lapsePairs(entries);
        equal(pairs.map(p => p.label), ['SilverStar → Coopers', 'Coopers → FFP']);
    });

    it('cycles the colours so two lines are never the same', () => {
        const pairs = lapsePairs(entries);
        equal(pairs.map(p => p.colour), LAPSE_COLOURS.slice(0, pairs.length));
    });

    it('is drawn upside down, so the flyable end is at the top', () => {
        lapsePairs(entries).forEach(pair => ok(pair.invert === true, pair.label));
    });

    it('drops a station that logged nothing today', () => {
        const dark = entries.map(e => e.station.shortName === 'Coopers' ? {...e, day: null} : e);
        equal(lapsePairs(dark).map(p => p.label), ['SilverStar → FFP']);
    });

    it('agrees with the lapse rate shown beside the tabs', () => {
        // The chart and the tag must not tell two different stories.
        const pair = lapsePairs(entries)[0];
        const column = lapseColumn(pair, days.ILUMBY7.times).filter(v => v !== null);
        ok(column.length, 'there is a lapse line to compare');

        const upper = {uk_hybrid: {elev: 5453, temp: days.IVERNO71.values.temp[0]}};
        const lower = {uk_hybrid: {elev: 3466, temp: days.ILUMBY7.values.temp[0]}};
        const tag = Number(weather.calculateLapseRate(upper, lower).lapseRate);

        ok(Math.abs(column[0] - tag) < 0.05, `chart ${column[0]} vs tag ${tag}`);
    });

    it('leaves a gap where either station was dark', () => {
        const pair = lapsePairs(entries)[0];
        // A time a year away lines up with nothing.
        equal(lapseColumn(pair, [days.ILUMBY7.times[0] + 31536000000]), [null]);
    });

    it('turns the panel upside down rather than the numbers', () => {
        const pair = lapsePairs(entries)[0];
        const day = {...days.ILUMBY7, values: {...days.ILUMBY7.values, [pair.key]: lapseColumn(pair, days.ILUMBY7.times)}};
        const markup = draw({day, catalogue: [...SERIES, pair], keys: [pair.key]});

        const labels = [...markup.matchAll(/class="chart-axis"[^>]*y="([\d.]+)"[^>]*>(-?[\d.]+)</g)]
            .map(m => ({y: Number(m[1]), value: Number(m[2])}))
            .filter(entry => Number.isFinite(entry.value));

        const lowest = labels.reduce((a, b) => a.value <= b.value ? a : b);
        const highest = labels.reduce((a, b) => a.value >= b.value ? a : b);

        // Smaller y is further up the page: the most negative rate belongs at
        // the top, because that is the air worth flying.
        ok(lowest.y < highest.y, `${lowest.value} should sit above ${highest.value}`);
    });
});

describe('the readouts configuration', () => {
    it('describes every tile completely', () => {
        READOUTS.forEach(readout => {
            ok(readout.label?.length, 'has a label');
            ok(readout.icon?.length, `${readout.label} has an icon`);
            ok(typeof readout.read === 'function', `${readout.label} knows where to look`);
        });
    });

    it('reads a value out of a real observation', async () => {
        const observation = (await fixture('current-ILUMBY7')).observations[0];
        const metrics = weather.describeObservation(observation);

        const values = READOUTS.map(r => r.read(observation, metrics));
        equal(values[0], '23.9', 'temperature leads');
        equal(READOUTS.find(r => r.label === 'Humidity').read(observation, metrics), '35');
    });

    it('drops the unit when there is no reading to put it on', async () => {
        // "— kPa" reads as a measurement; "—" reads as a missing one.
        const observation = (await fixture('current-ILUMBY7')).observations[0];
        const metrics = weather.describeObservation(observation);
        const pressure = READOUTS.find(r => r.label === 'Barometric Pressure');

        equal(pressure.read(observation, metrics), undefined);
        equal(pressure.unit(observation, metrics), '');
        equal(pressure.note(observation, metrics), 'This station does not report pressure.');
    });
});
