import {describe, it, equal, ok, fixture, freshenDay, withFetch, response} from './runner.js';
import api from '../scripts/wu-api.js';
import {Weather} from '../scripts/weather.js';
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

const goodDay = await fixture('day-ILUMBY7');
const parkDay = await fixture('day-ILUMBY8');

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
        const url = api.url('observations/all/1day', 'ILUMBY7');
        ok(url.includes('stationId=ILUMBY7'));
        ok(url.includes('units=h'), 'metric with UK hybrid');
        ok(url.includes('numericPrecision=decimal'), 'not rounded to integers');
        ok(url.includes('apiKey='));
    });

    it('reads a good response', async () => {
        await withFetch(() => response({body: goodDay}), async () => {
            const data = await api.day('ILUMBY7');
            equal(data.observations[0].stationID, goodDay.observations[0].stationID);
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
                await api.day('NOPE');
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error.message.includes('404'));
            }
        });
    });

    it('throws when the service is down', async () => {
        await withFetch(() => response({status: 503, body: {}}), async () => {
            try {
                await api.day('ILUMBY7');
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
                await api.day('ILUMBY7');
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error instanceof Error);
            }
        });
    });

    it('lets a network failure through to the caller', async () => {
        await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
            try {
                await api.day('ILUMBY7');
                ok(false, 'should have thrown');
            } catch (error) {
                equal(error.message, 'Failed to fetch');
            }
        });
    });
});

describe('reading a station that will not answer', () => {
    it('keeps the stations that answered when one does not', async () => {
        forget();
        const service = new Weather();
        const stations = [
            {id: 'ILUMBY7', cacheSeconds: 0, key: 'a'},
            {id: 'BROKEN', cacheSeconds: 0, key: 'b'}
        ];

        await withFetch(url => url.includes('BROKEN')
            ? response({status: 500, body: {}})
            : response({body: freshenDay(goodDay)}), async () => {

            const loaded = await service.loadStations(stations);

            equal(loaded.length, 2, 'both stations are still listed');
            equal(loaded[0].online, true);
            equal(loaded[1].online, false, 'the broken one is marked, not dropped');
            equal(loaded[1].day, null, 'and has no day to draw');
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
            equal(loaded[0].observation, null);
        });

        forget();
    });

    it('keeps the day of a station that has stopped reporting', async () => {
        // The whole point of holding the day separately from the readings: a
        // station that quit at noon is exactly the one whose morning is worth
        // drawing, even though nothing it says now may go on the page.
        forget();
        const service = new Weather();

        await withFetch(() => response({body: goodDay}), async () => {
            const [entry] = await service.loadStations([{id: 'ILUMBY7', cacheSeconds: 0, key: 'a'}]);

            equal(entry.online, false, 'the fixture is months old');
            ok(entry.day.times.length, 'but the day is still there to chart');
            ok(entry.observation, 'and the last bucket it published is kept');
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

describe('the newest bucket', () => {
    it('is the newest one, not the first', async () => {
        // The rows arrive oldest first. Reading the first would put breakfast's
        // wind on the page, and it would look entirely plausible.
        forget();
        const history = new History();

        await withFetch(() => response({body: goodDay}), async () => {
            const day = await history.load('ILUMBY7');
            equal(day.latest.obsTimeUtc, '2026-08-10T19:49:47Z');
            equal(day.latest.uk_hybrid.temp, 23.7);
        });

        forget();
    });

    it('survives the round trip through the cache', async () => {
        forget();
        const history = new History();

        await withFetch(() => response({body: goodDay}), async () => {
            await history.load('ILUMBY7');
        });

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            const day = await history.load('ILUMBY7');
            equal(calls.length, 0, 'served from cache');
            equal(day.latest.uk_hybrid.windSpeed, 7.1);
        });

        forget();
    });

    it('keeps each station to its own reading', async () => {
        forget();
        const history = new History();

        await withFetch(url => response({body: url.includes('ILUMBY8') ? parkDay : goodDay}),
            async () => {
                equal((await history.load('ILUMBY7')).latest.stationID, 'ILUMBY7');
                equal((await history.load('ILUMBY8')).latest.stationID, 'ILUMBY8');
            });

        forget();
    });
});

describe('how long a day is held', () => {
    /**
     * Plants a cached day of a given age.
     * @param {string} id - The station id
     * @param {number} minutes - How long ago it was fetched
     * @returns {void}
     */
    function cachedMinutesAgo(id, minutes) {
        localStorage.setItem(STORAGE_KEYS.day(id), JSON.stringify({
            fetchedAt: Date.now() - minutes * 60 * 1000,
            day: {times: [1], values: {temp: [1]}, dayStart: 0, dayEnd: 1}
        }));
    }

    it('holds a reference station for its own half hour', async () => {
        forget();
        const history = new History();
        cachedMinutesAgo('IVERNO71', 6);

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            await history.load('IVERNO71', 1800);
            equal(calls.length, 0, 'six minutes is nothing to a half-hour station');
        });

        forget();
    });

    it('re-reads the watched launch at the bucket cadence', async () => {
        forget();
        const history = new History();
        cachedMinutesAgo('ILUMBY7', 6);

        await withFetch(() => response({body: goodDay}), async calls => {
            await history.load('ILUMBY7', 60);
            equal(calls.length, 1, 'asked again');
        });

        forget();
    });

    it('will not be asked more often than the buckets arrive', async () => {
        // The launch station is configured at sixty seconds, which is the right
        // cadence for a reading and the wrong one for a day: four out of five
        // of those requests would re-read the same buckets.
        forget();
        const history = new History();
        cachedMinutesAgo('ILUMBY7', 3);

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            await history.load('ILUMBY7', 60);
            equal(calls.length, 0, 'floored at the five-minute cadence');
        });

        forget();
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
