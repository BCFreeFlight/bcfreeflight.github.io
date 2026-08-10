import {describe, it, equal, ok, fixture} from './runner.js';
import index from '../scripts/index.js';
import trends from '../scripts/trends.js';
import weather from '../scripts/weather.js';

/**
 * Refreshing without moving the page.
 *
 * The readings re-read themselves every minute. That must not cost the reader
 * their scroll position, their open measurement list, or the chart they were
 * reading — which it did, because the whole page was rebuilt from scratch each
 * time and a document that briefly has no height cannot hold a scroll offset.
 */

const observations = {};
for (const id of ['ILUMBY7', 'ILUMBY8', 'IVERNO71']) {
    observations[id] = (await fixture(`current-${id}`)).observations[0];
}

/**
 * A station entry as `Weather.loadStations` would hand it over.
 * @param {string} id - The station id
 * @param {Object} [options] - online, and an observation to override with
 * @returns {Object} The entry
 */
function entry(id, {online = true, observation = observations[id]} = {}) {
    return {
        station: {key: id.toLowerCase(), id, name: id, shortName: id, isDefault: id === 'ILUMBY7'},
        observation: online ? observation : undefined,
        metrics: weather.describeObservation(online ? observation : undefined),
        online
    };
}

const three = () => [entry('ILUMBY7'), entry('ILUMBY8'), entry('IVERNO71')];

/**
 * Builds the page the way a first load does, into a detached container.
 * @param {Object[]} loaded - Station entries
 * @returns {HTMLElement} The container, already on the document
 */
function build(loaded) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:900px';
    document.body.appendChild(host);

    const enabled = loaded.filter(item => item.online);
    host.innerHTML = index.renderTabs(loaded)
        + enabled.map(item => index.renderStationView(item)).join('');

    return host;
}

describe('deciding whether the page has to be rebuilt', () => {
    it('is the same signature for the same stations reporting', () => {
        equal(index.signature(three()), index.signature(three()));
    });

    it('does not change when only the readings change', () => {
        // The whole point: a new temperature must not rebuild the page.
        const warmer = three();
        warmer[0].observation = {...warmer[0].observation, uk_hybrid: {...warmer[0].observation.uk_hybrid, temp: 99}};

        equal(index.signature(three()), index.signature(warmer));
    });

    it('changes when a station goes dark', () => {
        const down = [entry('ILUMBY7'), entry('ILUMBY8', {online: false}), entry('IVERNO71')];
        ok(index.signature(three()) !== index.signature(down));
    });

    it('changes when a station comes back', () => {
        const down = [entry('ILUMBY7'), entry('ILUMBY8', {online: false}), entry('IVERNO71')];
        ok(index.signature(down) !== index.signature(three()));
    });

    it('changes when the stations are reordered', () => {
        const swapped = [entry('ILUMBY8'), entry('ILUMBY7'), entry('IVERNO71')];
        ok(index.signature(three()) !== index.signature(swapped));
    });
});

describe('refreshing in place', () => {
    it('writes the new readings into the page', () => {
        const host = build(three());

        const warmer = three();
        warmer[0].observation = {...observations.ILUMBY7, uk_hybrid: {...observations.ILUMBY7.uk_hybrid, temp: 31.4}};
        warmer[0].metrics = weather.describeObservation(warmer[0].observation);

        index.updateInPlace(warmer);

        const value = host.querySelector('.view[data-view="ilumby7"] .readout-value').textContent;
        ok(value.startsWith('31.4'), `temperature became ${value}`);

        host.remove();
    });

    it('keeps the very same elements, so nothing moves under the reader', () => {
        const host = build(three());

        const view = host.querySelector('.view[data-view="ilumby7"]');
        const trend = host.querySelector('.view[data-view="ilumby7"] .trend');
        const chartHost = host.querySelector('.view[data-view="ilumby7"] .chart-host');
        const tab = host.querySelector('.tab[data-view="ilumby7"]');

        index.updateInPlace(three());

        // Identity, not equality: a replaced node would be a rebuilt page.
        ok(view === host.querySelector('.view[data-view="ilumby7"]'), 'panel kept');
        ok(trend === host.querySelector('.view[data-view="ilumby7"] .trend'), 'chart card kept');
        ok(chartHost === host.querySelector('.view[data-view="ilumby7"] .chart-host'), 'chart kept');
        ok(tab === host.querySelector('.tab[data-view="ilumby7"]'), 'tab kept');

        host.remove();
    });

    it('leaves an open measurement list open', () => {
        const host = build(three());

        const menu = host.querySelector('.view[data-view="ilumby7"] .trend-menu');
        menu.hidden = false;

        index.updateInPlace(three());

        equal(host.querySelector('.view[data-view="ilumby7"] .trend-menu').hidden, false);
        host.remove();
    });

    it('updates the wind tiles', () => {
        const host = build(three());

        const veered = three();
        veered[0].observation = {...observations.ILUMBY7, winddir: 90, uk_hybrid: {...observations.ILUMBY7.uk_hybrid, windSpeed: 42.0}};

        index.updateInPlace(veered);

        const view = host.querySelector('.view[data-view="ilumby7"]');
        equal(view.querySelector('.wind-cardinal').textContent, 'E');
        ok(view.querySelector('.wind-speed').textContent.startsWith('42.0'));

        host.remove();
    });

    it('updates the lapse rate beside the tabs', () => {
        const host = build(three());

        const before = host.querySelector('.lapse-figure').textContent;

        const colder = three();
        colder[2].observation = {...observations.IVERNO71, uk_hybrid: {...observations.IVERNO71.uk_hybrid, temp: -20}};

        index.updateInPlace(colder);

        ok(host.querySelector('.lapse-figure').textContent !== before, 'the rate moved');
        host.remove();
    });

    it('marks a station offline in its tab without rebuilding the page', () => {
        // The signature would have changed, so this is not the path taken in
        // practice — but the tab must still tell the truth if it is.
        const host = build(three());

        index.updateInPlace([entry('ILUMBY7'), entry('ILUMBY8', {online: false}), entry('IVERNO71')]);

        equal(host.querySelector('.tab[data-view="ilumby8"] .tab-meta').textContent, 'offline');
        host.remove();
    });

    it('does not fall over when a panel is missing', () => {
        // Offline stations get a tab but no panel.
        const loaded = [entry('ILUMBY7'), entry('ILUMBY8', {online: false})];
        const host = build(loaded);

        index.updateInPlace(loaded);

        ok(!host.querySelector('.view[data-view="ilumby8"]'), 'still no panel');
        host.remove();
    });
});

describe('keeping the reader in place through a rebuild', () => {
    it('runs the rebuild it is given', () => {
        let ran = false;
        index.keepingPlace(() => { ran = true; });
        ok(ran);
    });

    it('puts the scroll position back after the page is replaced', async () => {
        // A tall page, so there is somewhere to scroll to.
        const tall = document.createElement('div');
        tall.style.cssText = 'height:4000px';
        document.body.appendChild(tall);

        window.scrollTo({top: 1200, behavior: 'instant'});
        const before = window.scrollY;
        ok(before > 0, 'the page scrolled');

        index.keepingPlace(() => {
            // What used to reset the scroll: the content collapses to nothing.
            tall.style.height = '0px';
            tall.getBoundingClientRect();
            tall.style.height = '4000px';
        });

        equal(window.scrollY, before, 'still where the reader left it');

        window.scrollTo({top: 0, behavior: 'instant'});
        tall.remove();
    });

    it('leaves a reader at the top of the page alone', () => {
        window.scrollTo({top: 0, behavior: 'instant'});
        index.keepingPlace(() => {});
        equal(window.scrollY, 0);
    });
});

describe('the charts through a refresh', () => {
    it('can take new readings without being unmounted', () => {
        // `mount` tears every chart down; `refresh` is the one a live update
        // uses, and it must exist and re-read rather than rebuild.
        ok(typeof trends.refresh === 'function');
        ok(trends.refresh.length === 0, 'takes no entries, because nothing is remounted');
    });
});
