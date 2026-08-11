import {describe, it, equal, ok, fixture, withFetch, response} from './runner.js';
import api, {onGrid, AirQualityApi} from '../scripts/air-api.js';
import {AirQuality} from '../scripts/air.js';
import {airColumn} from '../scripts/air-series.js';
import {READOUTS} from '../scripts/config/readouts.js';
import {STORAGE_KEYS} from '../scripts/config/defaults.js';

/**
 * Air quality, and the ways it is allowed to be missing.
 *
 * This is the first reading on the site that no station takes: it comes from a
 * model of the grid square the station stands in, on a different cadence, from a
 * different service. So the questions here are about the seams — that two
 * stations on one hillside cost one request rather than two, that hourly values
 * land on five-minute reading times without inventing anything between them, and
 * that a service which will not answer costs the page one tile and nothing else.
 *
 * Every response is staged. Nothing here touches the network.
 */

const good = await fixture('air-coopers');

// Two Weather Underground stations a couple of kilometres apart, and one up the
// hill. The first two are the pair that must not cost two requests.
const LUMBY = {lat: 50.284826, lon: -118.985672};
const FREEDOM = {lat: 50.266, lon: -118.963};
const SILVER_STAR = {lat: 50.359467, lon: -119.074575};

/**
 * Clears anything a previous test cached.
 * @returns {void}
 */
function forget() {
    Object.keys(localStorage)
        .filter(key => key.startsWith('air_quality_'))
        .forEach(key => localStorage.removeItem(key));
}

/**
 * The readout tile under test, so a rename cannot quietly skip these.
 * @returns {Object} The air quality readout
 */
function tile() {
    const readout = READOUTS.find(entry => entry.label === 'Air Quality');
    ok(readout, 'the air quality tile is still on the page');
    return readout;
}

describe('asking about the air', () => {
    it('asks for the readings the site shows, on the model\'s own grid', () => {
        const url = api.url(LUMBY.lat, LUMBY.lon);
        ok(url.includes('latitude=50.3'), 'snapped to a tenth of a degree');
        ok(url.includes('longitude=-119'));
        ok(url.includes('hourly=us_aqi,pm2_5'));
        ok(url.includes('current=us_aqi,pm2_5'));
        ok(url.includes('timeformat=unixtime'), 'epochs, not wall clocks');
        ok(!url.includes('apikey'), 'no key to leak');
    });

    it('covers the whole of a local day, either side of UTC', () => {
        // The response is in UTC and the day being charted is local, so a day
        // that starts at 07:00 UTC needs tomorrow's early hours to finish.
        const url = api.url(LUMBY.lat, LUMBY.lon);
        ok(url.includes('past_days=1'));
        ok(url.includes('forecast_days=2'));
    });

    it('rounds a coordinate to the grid the model is published on', () => {
        equal(onGrid(50.284826), 50.3);
        equal(onGrid(-118.985672), -119);
        equal(onGrid(50.359467), 50.4);
    });

    it('sends two stations on one hillside to the same square', () => {
        equal(api.url(LUMBY.lat, LUMBY.lon), api.url(FREEDOM.lat, FREEDOM.lon));
    });

    it('does not flatten the hill entirely', () => {
        ok(api.url(LUMBY.lat, LUMBY.lon) !== api.url(SILVER_STAR.lat, SILVER_STAR.lon),
            'a station 10 km up the valley is its own square');
    });

    it('throws when the service will not answer', async () => {
        const client = new AirQualityApi();

        await withFetch(() => response({status: 503, body: {}}), async () => {
            try {
                await client.read(LUMBY.lat, LUMBY.lon);
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error.message.includes('503'));
            }
        });
    });

    it('throws when the answer is not JSON', async () => {
        const client = new AirQualityApi();

        await withFetch(() => response({raw: '<html>Gateway Timeout</html>'}), async () => {
            try {
                await client.read(LUMBY.lat, LUMBY.lon);
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error instanceof Error);
            }
        });
    });
});

describe('reading the air', () => {
    it('shapes a good response into times the chart can plot', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => response({body: good}), async () => {
            const reading = await service.load(LUMBY.lat, LUMBY.lon);

            equal(reading.times.length, good.hourly.time.length);
            equal(reading.times[0], good.hourly.time[0] * 1000, 'seconds became milliseconds');
            equal(reading.usAqi, good.current.us_aqi);
            equal(reading.hourly.usAqi.length, reading.times.length);
            // What answered, which is the square rather than the station.
            equal(reading.latitude, good.latitude);
        });

        forget();
    });

    it('reports no reading rather than an error when the service is down', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            equal(await service.load(LUMBY.lat, LUMBY.lon), null);
        });

        forget();
    });

    it('caches nothing from a failure', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            await service.load(LUMBY.lat, LUMBY.lon);
        });

        equal(localStorage.getItem(STORAGE_KEYS.air(50.3, -119)), null);
        forget();
    });

    it('asks nothing at all without somewhere to ask about', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            equal(await service.load(undefined, undefined), null, 'a dark station has no coordinates');
            equal(calls.length, 0);
        });

        forget();
    });

    it('reads once and serves the rest from cache', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => response({body: good}), async calls => {
            await service.load(LUMBY.lat, LUMBY.lon);
            equal(calls.length, 1);
        });

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            ok(await service.load(LUMBY.lat, LUMBY.lon), 'still has a reading');
            equal(calls.length, 0, 'and did not ask again');
        });

        forget();
    });

    it('costs one request for two stations in the same square', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => response({body: good}), async calls => {
            // Both at once, which is what the page does: the tiles and the
            // chart ask for every station together.
            const readings = await Promise.all([
                service.load(LUMBY.lat, LUMBY.lon),
                service.load(FREEDOM.lat, FREEDOM.lon)
            ]);

            ok(readings.every(Boolean), 'both got a reading');
            equal(calls.length, 1, 'from one request');
        });

        forget();
    });

    it('re-reads once the held reading has aged out', async () => {
        forget();
        const service = new AirQuality();

        // Half an hour and one minute, against a half-hour hold.
        localStorage.setItem(STORAGE_KEYS.air(50.3, -119), JSON.stringify({
            fetchedAt: Date.now() - 31 * 60 * 1000,
            air: {times: [1], hourly: {usAqi: [1], pm25: [1]}, usAqi: 1}
        }));

        await withFetch(() => response({body: good}), async calls => {
            await service.load(LUMBY.lat, LUMBY.lon);
            equal(calls.length, 1, 'asked again');
        });

        forget();
    });

    it('ignores a cache entry that has been corrupted', async () => {
        forget();
        localStorage.setItem(STORAGE_KEYS.air(50.3, -119), '{not json');
        const service = new AirQuality();

        await withFetch(() => response({body: good}), async calls => {
            ok(await service.load(LUMBY.lat, LUMBY.lon), 'read the service instead of failing');
            equal(calls.length, 1);
        });

        forget();
    });

    it('survives a response with no hours in it', async () => {
        forget();
        const service = new AirQuality();

        await withFetch(() => response({body: {latitude: 50.3, hourly: {time: []}}}), async () => {
            equal(await service.load(LUMBY.lat, LUMBY.lon), null);
        });

        forget();
    });

    it('turns a missing hour into a gap, not a zero', async () => {
        forget();
        const service = new AirQuality();
        const holed = structuredClone(good);
        holed.hourly.us_aqi[2] = null;

        await withFetch(() => response({body: holed}), async () => {
            const reading = await service.load(LUMBY.lat, LUMBY.lon);
            equal(reading.hourly.usAqi[2], null);
            ok(reading.hourly.usAqi.some(value => value !== null), 'the rest survived');
        });

        forget();
    });
});

describe('what an index means', () => {
    const service = new AirQuality();

    it('names each band the way every air quality map does', () => {
        equal(service.describe(0).name, 'Good');
        equal(service.describe(50).name, 'Good');
        equal(service.describe(51).name, 'Moderate');
        equal(service.describe(150).name, 'Unhealthy for Sensitive Groups');
        equal(service.describe(191).name, 'Unhealthy');
        equal(service.describe(275).name, 'Very Unhealthy');
        equal(service.describe(500).name, 'Hazardous');
    });

    it('has nothing to say about a reading it does not have', () => {
        equal(service.describe(null), null);
        equal(service.describe(undefined), null);
    });
});

describe('the air on the chart', () => {
    // A morning of five-minute buckets, which is what a station logs.
    const times = Array.from({length: 24}, (unused, i) => Date.UTC(2026, 7, 10, 6) + i * 5 * 60 * 1000);

    const air = {
        times: [Date.UTC(2026, 7, 10, 6), Date.UTC(2026, 7, 10, 7), Date.UTC(2026, 7, 10, 8)],
        hourly: {usAqi: [100, 150, 200], pm25: [1, 2, 3]}
    };

    it('gives every reading time the hour that covers it', () => {
        const column = airColumn(air, times);

        equal(column.length, times.length, 'one value per reading');
        equal(column[0], 100, 'six o\'clock');
        // Twenty past seven is nearer seven than eight, and reads as seven.
        equal(column[15], 150);
        equal(column.at(-1), 200, 'and the last bucket has rolled on to eight');
    });

    it('draws a staircase rather than inventing a slope between hours', () => {
        const column = airColumn(air, times);
        const distinct = [...new Set(column)];

        equal(distinct.length, 3, 'three published hours, three values');
        ok(distinct.every(value => air.hourly.usAqi.includes(value)),
            'every drawn value is one the model published');
    });

    it('leaves a gap where the model says nothing', () => {
        const stale = {times: [Date.UTC(2026, 7, 9, 6)], hourly: {usAqi: [42], pm25: [1]}};
        const column = airColumn(stale, times);

        ok(column.every(value => value === null), 'yesterday does not answer for today');
    });

    it('offers no line at all when there is no reading', () => {
        equal(airColumn(null, times), null);
        equal(airColumn({times: []}, times), null);
    });
});

describe('the air quality tile', () => {
    it('shows the index and what it means', () => {
        const readout = tile();
        const air = {usAqi: 191};

        equal(readout.read({}, {}, air), 191);
        ok(readout.note({}, {}, air).startsWith('Unhealthy —'));
        ok(readout.note({}, {}, air).includes('Modelled for the area'),
            'says it was not measured at the station');
        equal(readout.unit({}, {}, air), 'AQI');
    });

    it('reads as missing rather than as zero when there is no reading', () => {
        const readout = tile();

        equal(readout.read({}, {}, null) ?? null, null);
        equal(readout.note({}, {}, null), null);
        equal(readout.unit({}, {}, null), '', 'and shows no unit beside the dash');
    });

    it('survives a service that answered without a current reading', () => {
        const readout = tile();
        const air = {usAqi: null, times: [1], hourly: {usAqi: [null]}};

        equal(readout.read({}, {}, air) ?? null, null);
        equal(readout.note({}, {}, air), null);
        equal(readout.unit({}, {}, air), '');
    });
});
