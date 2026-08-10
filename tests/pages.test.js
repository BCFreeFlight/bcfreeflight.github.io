import {describe, it, equal, ok} from './runner.js';
import sites from '../scripts/sites.js';
import youtube from '../scripts/youtube.js';
import home from '../scripts/home.js';
import index from '../scripts/index.js';
import {
    DEFAULT_CACHE_SECONDS,
    MINIMUM_REFRESH_SECONDS,
    PLAYER_PARAMS,
    REFERENCE_CACHE_SECONDS,
    STORAGE_KEYS
} from '../scripts/config/defaults.js';

/**
 * The site configuration, and the pages built from it.
 *
 * These read the real sites.json rather than a fixture, so a change to it that
 * would break a page is caught here.
 */

const site = await sites.site('coopers');

describe('site configuration', () => {
    it('resolves a site by its slug', () => {
        equal(site.slug, 'coopers');
        ok(site.name.length);
        ok(site.stations.length >= 1);
    });

    it('refuses a site that is not configured', async () => {
        try {
            await sites.site('nowhere');
            ok(false, 'should have thrown');
        } catch (error) {
            ok(error.message.includes('nowhere'));
        }
    });

    it('fills in what a station leaves out', () => {
        const station = sites.station({wunderground: 'IABCDEF1'}, 3);
        equal(station.key, 'iabcdef1');
        equal(station.name, 'IABCDEF1');
        equal(station.shortName, 'IABCDEF1');
        equal(station.isDefault, false);
        equal(station.order, 3);
        equal(station.youtube, null);
    });

    it('holds a reference station longer than the one being watched', () => {
        equal(sites.station({wunderground: 'A', default: true}, 0).cacheSeconds, DEFAULT_CACHE_SECONDS);
        equal(sites.station({wunderground: 'B'}, 1).cacheSeconds, REFERENCE_CACHE_SECONDS);
    });

    it('lets a station state its own timeout', () => {
        equal(sites.station({wunderground: 'A', cacheSeconds: 120}, 0).cacheSeconds, 120);
    });

    it('leads the tabs with the default station', () => {
        const shuffled = [...site.stations].reverse();
        equal(sites.inTabOrder(shuffled)[0].isDefault, true);
    });

    it('keeps the configured order behind it', () => {
        const ordered = sites.inTabOrder(site.stations);
        const rest = ordered.slice(1).map(station => station.order);
        equal(rest, [...rest].sort((a, b) => a - b));
    });

    it('polls at the shortest timeout among its stations', () => {
        const stations = [{cacheSeconds: 1800}, {cacheSeconds: 60}, {cacheSeconds: 300}];
        equal(sites.refreshMs(stations), 60 * 1000);
    });

    it('will not poll faster than the floor, however it is configured', () => {
        // A station configured at a few seconds must not turn the page into a
        // polling loop.
        equal(sites.refreshMs([{cacheSeconds: 1}]), MINIMUM_REFRESH_SECONDS * 1000);
    });

    it('falls back when no station states a usable timeout', () => {
        equal(sites.refreshMs([]), REFERENCE_CACHE_SECONDS * 1000);
        equal(sites.refreshMs([{cacheSeconds: 0}, {cacheSeconds: -5}]), REFERENCE_CACHE_SECONDS * 1000);
    });

    it('finds the station carrying the camera', () => {
        ok(sites.withCamera(site.stations));
        equal(sites.withCamera([{youtube: null}]), null);
    });

    it('normalises a bare video id into a source', () => {
        equal(sites.youtube('abc123'), {channel: null, video: 'abc123'});
        equal(sites.youtube({channel: 'UC1'}), {channel: 'UC1', video: null});
        equal(sites.youtube(null), null);
    });

    it('lists every configured site for the front page', async () => {
        const all = await sites.all();
        ok(all.length >= 1);
        ok(all.some(entry => entry.slug === 'coopers'));
        ok(all.every(entry => Array.isArray(entry.stations)));
    });

    it('is read once and shared, however many callers ask', async () => {
        const before = sites.pending;
        await Promise.all([sites.site('coopers'), sites.all(), sites.site('coopers')]);
        equal(sites.pending, before, 'the same in-flight request');
    });
});

describe('the camera source', () => {
    it('prefers a channel, which follows whatever is on air now', () => {
        // A video id names one broadcast and goes stale the next time the
        // stream restarts.
        const url = youtube.embedUrl({channel: 'UC1', video: 'abc'});
        ok(url.includes('/embed/live_stream'));
        ok(url.includes('channel=UC1'));
    });

    it('falls back to a video id', () => {
        equal(youtube.embedUrl({channel: null, video: 'abc'}), 'https://www.youtube.com/embed/abc');
    });

    it('has no URL without a source', () => {
        equal(youtube.embedUrl(null), null);
        equal(youtube.embedUrl({channel: null, video: null}), null);
    });

    it('carries the player settings through', () => {
        const url = youtube.embedUrl({channel: 'UC1'}, PLAYER_PARAMS);
        Object.entries(PLAYER_PARAMS).forEach(([key, value]) =>
            ok(url.includes(`${key}=${value}`), `${key} is set`));
    });
});

describe('storage keys', () => {
    it('keeps the names readers already have saved', () => {
        // Renaming any of these silently loses a reader's settings and their
        // cached readings.
        equal(STORAGE_KEYS.observation('ILUMBY7'), 'weather_cache_ILUMBY7');
        equal(STORAGE_KEYS.day('ILUMBY7'), 'weather_history_ILUMBY7');
        equal(STORAGE_KEYS.liveView, 'live_view_mode');
        equal(STORAGE_KEYS.liveWeather, 'live_weather_visible');
        equal(STORAGE_KEYS.trendSeries, 'trend_series');
        equal(STORAGE_KEYS.trendMode, 'trend_mode');
    });
});

describe('the front page', () => {
    it('offers the readings and the camera for a site that has one', () => {
        const markup = home.renderSite(site);
        ok(markup.includes(`href="/sites/${site.slug}"`), 'weather');
        ok(markup.includes(`href="/sites/${site.slug}/live"`), 'live');
        ok(markup.includes(site.name));
    });

    it('does not link to a stream that does not exist', () => {
        const markup = home.renderSite({slug: 'nocamera', name: 'No Camera', stations: [{}]});
        ok(markup.includes('href="/sites/nocamera"'));
        ok(!markup.includes('/live'), 'no camera, no live link');
    });

    it('says so rather than leaving an empty page', async () => {
        const host = document.createElement('div');
        host.id = 'sites';
        document.body.appendChild(host);

        const real = sites.all;
        sites.all = async () => { throw new Error('unreachable'); };

        try {
            await home.render();
            ok(host.textContent.includes('unavailable'));
        } finally {
            sites.all = real;
            host.remove();
        }
    });
});

describe('the weather page', () => {
    it('shows a station that is offline rather than hiding it', () => {
        const loaded = [
            {station: {key: 'a', name: 'A'}, online: true, observation: {uk_hybrid: {elev: 1000}}},
            {station: {key: 'b', name: 'B'}, online: false}
        ];

        const markup = index.renderTabs(loaded);
        ok(markup.includes('offline'));
        ok(markup.includes('disabled'));
        ok(markup.includes('1,000 ft ASL'));
    });

    it('says which stations are missing when it cannot pair them', () => {
        const markup = index.renderLapseTag([
            {station: {key: 'a', name: 'Alpha'}, online: false},
            {station: {key: 'b', name: 'Beta'}, online: false}
        ]);

        ok(markup.includes('Alpha and Beta offline'));
    });

    it('asks for two stations when only one is reporting', () => {
        const markup = index.renderLapseTag([
            {station: {key: 'a', name: 'Alpha'}, online: true, observation: {uk_hybrid: {elev: 1000, temp: 10}}}
        ]);

        ok(markup.includes('Needs two stations reporting'));
    });

    it('turns the wind arrow away from the direction it is named for', () => {
        const markup = index.renderWindArrow({cardinal: 'W', cardinalWords: 'west', rotation: 270 + 180});
        ok(markup.includes('rotate(450deg)'));
        ok(markup.includes('Wind from the west'));
    });

    it('names the arrow even when the direction is unknown', () => {
        ok(index.renderWindArrow({rotation: 0}).includes('unknown direction'));
    });
});
