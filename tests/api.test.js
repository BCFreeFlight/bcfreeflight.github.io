import {describe, it, equal, ok, fixture, withFetch, response} from './runner.js';
import api from '../scripts/wu-api.js';
import {WeatherUnderground, Weather} from '../scripts/weather.js';
import {History} from '../scripts/history.js';
import sites from '../scripts/sites.js';
import {STORAGE_KEYS} from '../scripts/config/defaults.js';

/**
 * What happens when the API does not cooperate.
 *
 * Stations go offline, the service returns a 500, a proxy hands back an HTML
 * error page with a JSON content type, a station that has just been installed
 * has nothing logged yet. None of that may take the page down: the readings
 * that did arrive stay on screen, and the ones that did not read as missing.
 *
 * Every response here is staged. Nothing in this file touches the network — the
 * runner refuses any request that leaves the origin.
 */

const good = await fixture('current-ILUMBY7');
const goodDay = await fixture('day-ILUMBY7');

/**
 * Clears anything a previous test cached, so a stubbed failure is not quietly
 * served from a good reading left behind by another test.
 * @returns {void}
 */
function forget() {
    Object.keys(localStorage)
        .filter(key => key.startsWith('weather_cache_') || key.startsWith('weather_history_'))
        .forEach(key => localStorage.removeItem(key));
}

describe('the API client', () => {
    it('asks for the units and precision the site reads in', () => {
        const url = api.url('observations/current', 'ILUMBY7');
        ok(url.includes('stationId=ILUMBY7'));
        ok(url.includes('units=h'), 'metric with UK hybrid');
        ok(url.includes('numericPrecision=decimal'), 'not rounded to integers');
        ok(url.includes('apiKey='));
    });

    it('builds both endpoints the same way', () => {
        const current = api.url('observations/current', 'X');
        const day = api.url('observations/all/1day', 'X');
        equal(current.replace('observations/current', 'PATH'), day.replace('observations/all/1day', 'PATH'));
    });

    it('reads a good response', async () => {
        await withFetch(() => response({body: good}), async () => {
            const data = await api.current('ILUMBY7');
            equal(data.observations[0].stationID, good.observations[0].stationID);
        });
    });

    it('treats a station with nothing logged as empty, not broken', async () => {
        await withFetch(() => response({status: 204}), async () => {
            equal(await api.day('NEWSTATION'), null);
        });
    });

    it('throws on a station that is not there', async () => {
        await withFetch(() => response({status: 404, body: {}}), async () => {
            try {
                await api.current('NOPE');
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error.message.includes('404'));
            }
        });
    });

    it('throws when the service is down', async () => {
        await withFetch(() => response({status: 503, body: {}}), async () => {
            try {
                await api.current('ILUMBY7');
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error.message.includes('503'));
            }
        });
    });

    it('throws when the answer is not JSON', async () => {
        // What a captive portal or a proxy error page looks like from here.
        await withFetch(() => response({raw: '<html>Gateway Timeout</html>'}), async () => {
            try {
                await api.current('ILUMBY7');
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error instanceof Error);
            }
        });
    });

    it('lets a network failure through to the caller', async () => {
        await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
            try {
                await api.current('ILUMBY7');
                ok(false, 'should have thrown');
            } catch (error) {
                equal(error.message, 'Failed to fetch');
            }
        });
    });
});

describe('reading a station that will not answer', () => {
    it('reports no data rather than an error', async () => {
        forget();
        const wu = new WeatherUnderground();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            equal(await wu.getWeather('ILUMBY7'), null);
        });
    });

    it('caches nothing from a failure', async () => {
        forget();
        const wu = new WeatherUnderground();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            await wu.getWeather('ILUMBY7', 60);
        });

        equal(localStorage.getItem(STORAGE_KEYS.observation('ILUMBY7')), null);
    });

    it('serves the last good reading while it is still fresh', async () => {
        forget();
        const wu = new WeatherUnderground();
        const fresh = structuredClone(good);
        fresh.observations[0].obsTimeUtc = new Date().toISOString();

        await withFetch(() => response({body: fresh}), async () => {
            await wu.getWeather('ILUMBY7', 600);
        });

        // The station is now unreachable, but the reading is minutes old.
        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            const cached = await wu.getWeather('ILUMBY7', 600);
            ok(cached, 'still has a reading');
            equal(calls.length, 0, 'and did not ask again');
        });

        forget();
    });

    it('refetches once the cached reading has gone stale', async () => {
        forget();
        const wu = new WeatherUnderground();

        // The fixture is from an earlier day, so it is stale by any timeout.
        await withFetch(() => response({body: good}), async () => {
            await wu.getWeather('ILUMBY7', 60);
        });

        await withFetch(() => response({body: good}), async calls => {
            await wu.getWeather('ILUMBY7', 60);
            equal(calls.length, 1, 'asked again');
        });

        forget();
    });

    it('ignores a cache entry that has been corrupted', async () => {
        forget();
        localStorage.setItem(STORAGE_KEYS.observation('ILUMBY7'), '{not json');
        const wu = new WeatherUnderground();

        await withFetch(() => response({body: good}), async calls => {
            const data = await wu.getWeather('ILUMBY7', 600);
            ok(data, 'read the station instead of failing');
            equal(calls.length, 1);
        });

        forget();
    });

    it('keeps the stations that answered when one does not', async () => {
        forget();
        const service = new Weather();
        const stations = [
            {id: 'ILUMBY7', cacheSeconds: 0, key: 'a'},
            {id: 'BROKEN', cacheSeconds: 0, key: 'b'}
        ];

        await withFetch(url => url.includes('BROKEN')
            ? response({status: 500, body: {}})
            : response({body: good}), async () => {

            const loaded = await service.loadStations(stations);

            equal(loaded.length, 2, 'both stations are still listed');
            equal(loaded[0].online, true);
            equal(loaded[1].online, false, 'the broken one is marked, not dropped');
            // An offline station still has a full metrics shape to render.
            equal(loaded[1].metrics.humidity, null);
        });

        forget();
    });

    it('survives a response with no observations in it', async () => {
        forget();
        const service = new Weather();

        await withFetch(() => response({body: {observations: []}}), async () => {
            const loaded = await service.loadStations([{id: 'X', cacheSeconds: 0, key: 'x'}]);
            equal(loaded[0].online, false);
        });

        forget();
    });
});

describe('reading a day that will not load', () => {
    it('draws nothing rather than failing when the day is missing', async () => {
        forget();
        const history = new History();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            equal(await history.load('ILUMBY7'), null);
        });
    });

    it('treats a station with nothing logged today as an empty day', async () => {
        forget();
        const history = new History();

        await withFetch(() => response({status: 204}), async () => {
            equal(await history.load('NEWSTATION'), null);
        });
    });

    it('survives a day with no buckets in it', async () => {
        forget();
        const history = new History();

        await withFetch(() => response({body: {observations: []}}), async () => {
            equal(await history.load('X'), null);
        });
    });

    it('caches nothing from a failed read', async () => {
        forget();
        const history = new History();

        await withFetch(() => response({status: 404, body: {}}), async () => {
            await history.load('ILUMBY7');
        });

        equal(localStorage.getItem(STORAGE_KEYS.day('ILUMBY7')), null);
    });

    it('reads the day once and serves it from cache after', async () => {
        forget();
        const history = new History();

        await withFetch(() => response({body: goodDay}), async calls => {
            const day = await history.load('ILUMBY7');
            ok(day.times.length, 'a day was read');
            equal(calls.length, 1);
        });

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            const day = await history.load('ILUMBY7');
            ok(day.times.length, 'served from cache');
            equal(calls.length, 0);
        });

        forget();
    });

    it('re-reads when the cached day has aged out', async () => {
        forget();
        const history = new History();

        // Six minutes old, against a five-minute cache.
        localStorage.setItem(STORAGE_KEYS.day('ILUMBY7'), JSON.stringify({
            fetchedAt: Date.now() - 6 * 60 * 1000,
            day: {times: [1], values: {temp: [1]}, dayStart: 0, dayEnd: 1}
        }));

        await withFetch(() => response({body: goodDay}), async calls => {
            await history.load('ILUMBY7');
            equal(calls.length, 1, 'asked again');
        });

        forget();
    });

    it('ignores a corrupted cached day', async () => {
        forget();
        localStorage.setItem(STORAGE_KEYS.day('ILUMBY7'), 'not json at all');
        const history = new History();

        await withFetch(() => response({body: goodDay}), async calls => {
            ok(await history.load('ILUMBY7'));
            equal(calls.length, 1);
        });

        forget();
    });

    it('skips a measurement whose column is entirely missing', async () => {
        forget();
        const history = new History();
        const sparse = {
            observations: goodDay.observations.map(row => ({
                ...row,
                uv: null,
                uvHigh: null,
                solarRadiationHigh: null
            }))
        };

        await withFetch(() => response({body: sparse}), async () => {
            const day = await history.load('SPARSE');
            ok(!('uv' in day.values), 'no UV offered');
            ok(!('solar' in day.values), 'no sunlight offered');
            ok('temp' in day.values, 'temperature still offered');
        });

        forget();
    });

    it('turns a non-numeric reading into a gap, not a zero', async () => {
        forget();
        const history = new History();
        const broken = {
            observations: goodDay.observations.map((row, i) => i % 2
                ? {...row, uk_hybrid: {...row.uk_hybrid, tempAvg: null}}
                : row)
        };

        await withFetch(() => response({body: broken}), async () => {
            const day = await history.load('GAPPY');
            ok(day.values.temp.includes(null), 'the bad readings are gaps');
            ok(!day.values.temp.includes(0), 'and not zeroes along the floor');
        });

        forget();
    });
});

describe('the site configuration failing to load', () => {
    it('reports a configuration that is not there', async () => {
        const fresh = new sites.constructor();

        await withFetch(() => response({status: 404, body: {}}), async () => {
            try {
                await fresh.site('coopers');
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error.message.includes('404'));
            }
        });
    });

    it('lets the next caller try again rather than caching the failure', async () => {
        const fresh = new sites.constructor();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            try { await fresh.load(); } catch (error) { /* expected */ }
        });

        equal(fresh.pending, null, 'the failed request was not kept');

        await withFetch(() => response({body: {sites: {x: {name: 'X', stations: []}}}}), async () => {
            const site = await fresh.site('x');
            equal(site.name, 'X');
        });
    });

    it('survives a configuration with no sites in it', async () => {
        const fresh = new sites.constructor();

        await withFetch(() => response({body: {}}), async () => {
            equal(await fresh.all(), []);
        });
    });
});

describe('the network guard', () => {
    it('refuses to let a test reach the live API', async () => {
        try {
            await fetch('https://api.weather.com/v2/pws/observations/current');
            ok(false, 'the guard let it through');
        } catch (error) {
            ok(error.message.includes('must not call out'));
        }
    });
});
