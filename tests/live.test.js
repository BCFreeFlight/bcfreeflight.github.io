import {describe, it, equal, ok, fixture, freshenDay, withFetch, response} from './runner.js';
import live from '../scripts/live.js';
import sites from '../scripts/sites.js';
import {History} from '../scripts/history.js';
import {STORAGE_KEYS} from '../scripts/config/defaults.js';
import {settle} from '../scripts/lib/animate.js';

/**
 * The overlay on the video.
 *
 * The stream page shows three readings over the top of the camera and nothing
 * else, on a screen at a launch that nobody is standing at. It had no coverage
 * at all until the readings moved onto the day: before that it read the same
 * current-observation endpoint as everything else, and now it reads a day per
 * station on a page that refreshes itself for hours.
 *
 * Every response is staged. The runner refuses anything that leaves the origin,
 * so the only live request here is for sites.json, which is a file in this
 * repository.
 */

const days = {};
for (const id of ['ILUMBY7', 'ILUMBY8', 'IVERNO71']) {
    days[id] = await fixture(`day-${id}`);
}

/**
 * Drops any day a previous test cached, so a staged failure here is not quietly
 * served from a good day left behind by the test before it.
 * @returns {void}
 */
function forget() {
    Object.keys(localStorage)
        .filter(key => key.startsWith('weather_history_'))
        .forEach(key => localStorage.removeItem(key));
}

/**
 * The three tiles the live page carries, as sites/coopers/live.html writes them.
 * @returns {HTMLElement} The overlay, already on the document
 */
function overlay() {
    forget();
    document.body.dataset.site = 'coopers';

    const host = document.createElement('div');
    host.id = 'weather-overlay';
    host.style.cssText = 'position:absolute;left:-9999px;top:0';
    host.innerHTML = ['wind', 'temperature', 'rainfall'].map(id => `
        <div class="weather-item" id="${id}">
            <i class="material-symbols-outlined weather-icon">navigation</i>
            <div class="weather-value">Loading...</div>
            <div class="weather-title">${id}</div>
        </div>`).join('');

    document.body.appendChild(host);
    return host;
}

/**
 * Serves each station its own day, freshened unless told otherwise.
 * @param {Object} [options] - minutesAgo, and a station id to fail for
 * @returns {function(string): Response} A fetch stub
 */
function stationDays({minutesAgo = 1, broken = null} = {}) {
    return url => {
        const id = Object.keys(days).find(station => url.includes(station));

        if (!id) throw new Error(`Unexpected request: ${url}`);
        if (id === broken) return response({status: 500, body: {}});

        return response({body: freshenDay(days[id], minutesAgo)});
    };
}

/**
 * Draws the overlay once against a staged fetch, then stops the loop.
 * @param {function(string): Response} stub - Stands in for fetch
 * @returns {Promise<HTMLElement>} The overlay, still on the document
 */
async function draw(stub) {
    const host = overlay();

    try {
        await withFetch(stub, () => live.loadAndDisplayWeatherOverlay());
        // The tiles count to their readings over two seconds. What is checked
        // here is where they land.
        settle();
    } finally {
        // The overlay queues its next read in a `finally`, on a Loop shared by
        // the whole module. Left running, it fires a minute later against the
        // real fetch and fails an unrelated test with the network guard's
        // message rather than anything about this page.
        live.overlay.cancel();
    }

    return host;
}

/**
 * @param {HTMLElement} host - The overlay
 * @param {string} id - A tile id
 * @returns {string} What the tile reads
 */
const value = (host, id) => host.querySelector(`#${id} .weather-value`).textContent;

describe('the live overlay', () => {
    it('reads the newest five-minute bucket', async () => {
        const host = await draw(stationDays());

        try {
            // The bucket's own average and its peak, not an instant: 7.1 km/h
            // from 238º, which is the last row of the captured day.
            equal(value(host, 'wind'), 'WSW 7.1 km/h');
            equal(value(host, 'temperature'), '23.7 ºC');
            equal(value(host, 'rainfall'), '0.00 mm');
        } finally {
            host.remove();
        }
    });

    it('names the gust in the title, where there is one', async () => {
        const host = await draw(stationDays());

        try {
            equal(host.querySelector('#wind .weather-title').textContent, 'Gusting to 16.6 km/h');
        } finally {
            host.remove();
        }
    });

    it('turns the arrow away from the direction the wind is named for', async () => {
        const host = await draw(stationDays());

        try {
            const icon = host.querySelector('#wind .weather-icon');
            const turned = Number(/rotate\((-?[\d.]+)deg\)/.exec(icon.style.transform)[1]);

            // The bearing, not the number: the arrow turns the short way round
            // from wherever it was pointing, so it lands on whichever angle
            // means "from the WSW" is nearest — 58º here, not 418º.
            equal(((turned % 360) + 360) % 360, (238 + 180) % 360);
        } finally {
            host.remove();
        }
    });

    it('says nothing rather than something stale when every station has stopped', async () => {
        // The captured days are months old, so nothing in them is reporting.
        const host = await draw(url => {
            const id = Object.keys(days).find(station => url.includes(station));
            return response({body: days[id]});
        });

        try {
            equal(value(host, 'wind'), 'Loading...', 'the tile was never written');
        } finally {
            host.remove();
        }
    });

    it('keeps drawing when one station will not answer', async () => {
        const host = await draw(stationDays({broken: 'IVERNO71'}));

        try {
            equal(value(host, 'wind'), 'WSW 7.1 km/h', 'the station it speaks for is unaffected');
        } finally {
            host.remove();
        }
    });

    it('re-reads a reference station before its cached day goes stale', async () => {
        const host = overlay();
        const history = new History();

        // Both reference stations, cached as they stood months ago and fetched
        // sixteen minutes back. The half hour those stations ask for would
        // serve that day again, and every bucket in it is far past the twenty
        // minutes that puts a station offline: the pairs the lapse rate is
        // drawn from would both vanish while the page refused to look again.
        for (const id of ['ILUMBY8', 'IVERNO71']) {
            await withFetch(() => response({body: days[id]}), () => history.load(id, 30 * 60));

            const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.day(id)));
            cached.fetchedAt = Date.now() - 16 * 60 * 1000;
            localStorage.setItem(STORAGE_KEYS.day(id), JSON.stringify(cached));
        }

        try {
            await withFetch(stationDays(), () => live.loadAndDisplayWeatherOverlay());
            settle();

            equal(host.querySelectorAll('.lapse-row').length, 2, 'both pairs still reporting');
        } finally {
            live.overlay.cancel();
            host.remove();
        }
    });

    it('reads each station once, for both the readings and the lapse rate', async () => {
        const host = overlay();

        try {
            await withFetch(stationDays(), async calls => {
                await live.loadAndDisplayWeatherOverlay();

                const asked = calls.filter(url => url.includes('observations/all/1day'));
                equal(asked.length, 3, 'one day each, and no second endpoint');
                equal(calls.filter(url => url.includes('observations/current')).length, 0);
            });
        } finally {
            live.overlay.cancel();
            host.remove();
        }
    });
});
