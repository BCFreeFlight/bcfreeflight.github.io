import {describe, it, equal, ok, fixture} from './runner.js';
import index from '../scripts/index.js';
import trends from '../scripts/trends.js';
import weather from '../scripts/weather.js';
import {settle} from '../scripts/lib/animate.js';
import {observationFrom} from '../scripts/config/series.js';

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
    observations[id] = observationFrom((await fixture(`day-${id}`)).observations.at(-1));
}

const METRES = {ILUMBY7: 1056.4, ILUMBY8: 495.0, IVERNO71: 1662.1};

// A day, only as far as the page cares: something to hang a chart on.
const A_DAY = {times: [1], values: {temp: [1]}, dayStart: 0, dayEnd: 1};

/**
 * A station entry as `Weather.loadStations` would hand it over.
 *
 * `online` and `day` are separate on purpose. A station that has stopped
 * reporting still has the hours it did record, and the page keeps its chart
 * while dropping its readings.
 *
 * @param {string} id - The station id
 * @param {Object} [options] - online, day, and an observation to override with
 * @returns {Object} The entry
 */
function entry(id, {online = true, day = A_DAY, observation = observations[id]} = {}) {
    const station = {
        key: id.toLowerCase(), id, name: id, shortName: id, isDefault: id === 'ILUMBY7',
        // The site's own height, in metres, as sites.json states it: the tabs
        // and the lapse rate read it from here rather than from the reading.
        coordinates: {elevation: METRES[id]}
    };

    return {
        station,
        day,
        observation: online ? observation : undefined,
        metrics: weather.describeObservation(online ? observation : undefined, METRES[id]),
        online
    };
}

const three = () => [entry('ILUMBY7'), entry('ILUMBY8'), entry('IVERNO71')];

/**
 * Refreshes the page and lands every tile on its new value.
 *
 * A tile counts to its reading over two seconds now, so a test that looks
 * straight after a refresh sees a number on its way rather than the one it was
 * going to. What is being checked here is where they arrive; the counting
 * itself has its own tests.
 *
 * @param {Object[]} loaded - Station entries
 * @returns {void}
 */
function refresh(loaded) {
    index.updateInPlace(loaded);
    settle();
}

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

        refresh(warmer);

        const value = host.querySelector('.view[data-view="ilumby7"] .readout-value').textContent;
        ok(value.startsWith('31.4'), `temperature became ${value}`);

        host.remove();
    });

    it('moves a reading to its new value rather than swapping it', async () => {
        // Not settled: the point is that a refresh leaves the tile counting.
        // Replacing a panel wholesale would land every value in one frame, and
        // this is what would notice if that came back.
        const host = build(three());

        const warmer = three();
        warmer[0].observation = {...observations.ILUMBY7, uk_hybrid: {...observations.ILUMBY7.uk_hybrid, temp: 31.4}};
        warmer[0].metrics = weather.describeObservation(warmer[0].observation, METRES.ILUMBY7);

        index.updateInPlace(warmer);

        const value = host.querySelector('.view[data-view="ilumby7"] .readout-value');
        let partway = value.textContent;

        for (let frame = 0; frame < 60 && partway.startsWith('23.7'); frame++) {
            await new Promise(requestAnimationFrame);
            partway = value.textContent;
        }

        settle();

        const reached = Number.parseFloat(partway);
        ok(reached > 23.7 && reached < 31.4, `counting past ${partway}`);
        ok(value.textContent.startsWith('31.4'), 'and it lands on the reading');

        host.remove();
    });

    it('renames the stations the lapse rate is waiting on', () => {
        // No pair either side of the refresh, so there is no stack to write
        // into — but which stations are missing has changed, and the tag says
        // so rather than keeping the name it had.
        const host = build(three());

        refresh([
            entry('ILUMBY7', {online: false}),
            entry('ILUMBY8', {online: false}),
            entry('IVERNO71')
        ]);
        refresh([
            entry('ILUMBY7'),
            entry('ILUMBY8', {online: false}),
            entry('IVERNO71', {online: false})
        ]);

        const tag = document.querySelector('.lapse-tag').textContent;
        ok(tag.includes('ILUMBY8 and IVERNO71'), `named the missing pair, got: ${tag.trim()}`);

        host.remove();
    });

    it('keeps the tiles themselves, so a reading has something to move in', () => {
        // A tile that is thrown away cannot count to anything. These are the
        // elements the readings are written into, and they have to survive a
        // refresh for any of the movement above to be possible.
        const host = build(three());

        const view = host.querySelector('.view[data-view="ilumby7"]');
        const arrow = view.querySelector('.wind-arrow');
        const speed = view.querySelector('.wind-speed');
        const readouts = view.querySelector('.readouts');
        const readout = view.querySelector('.readout-value');
        const tag = host.querySelector('.lapse-tag');

        refresh(three());

        ok(arrow === view.querySelector('.wind-arrow'), 'arrow kept');
        ok(speed === view.querySelector('.wind-speed'), 'wind speed kept');
        ok(readouts === view.querySelector('.readouts'), 'readouts kept');
        ok(readout === view.querySelector('.readout-value'), 'each readout kept');
        ok(tag === host.querySelector('.lapse-tag'), 'lapse tag kept');

        host.remove();
    });

    it('keeps the very same elements, so nothing moves under the reader', () => {
        const host = build(three());

        const view = host.querySelector('.view[data-view="ilumby7"]');
        const trend = host.querySelector('.view[data-view="ilumby7"] .trend');
        const chartHost = host.querySelector('.view[data-view="ilumby7"] .chart-host');
        const tab = host.querySelector('.tab[data-view="ilumby7"]');

        refresh(three());

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

        refresh(three());

        equal(host.querySelector('.view[data-view="ilumby7"] .trend-menu').hidden, false);
        host.remove();
    });

    it('updates the wind tiles', () => {
        const host = build(three());

        const veered = three();
        veered[0].observation = {...observations.ILUMBY7, winddir: 90, uk_hybrid: {...observations.ILUMBY7.uk_hybrid, windSpeed: 42.0}};

        refresh(veered);

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

        refresh(colder);

        ok(host.querySelector('.lapse-figure').textContent !== before, 'the rate moved');
        host.remove();
    });

    it('marks a station offline in its tab without rebuilding the page', () => {
        // The signature would have changed, so this is not the path taken in
        // practice — but the tab must still tell the truth if it is.
        const host = build(three());

        refresh([entry('ILUMBY7'), entry('ILUMBY8', {online: false}), entry('IVERNO71')]);

        equal(host.querySelector('.tab[data-view="ilumby8"] .tab-meta').textContent, 'offline');
        host.remove();
    });

    it('does not fall over when a panel is missing', () => {
        // Offline stations get a tab but no panel.
        const loaded = [entry('ILUMBY7'), entry('ILUMBY8', {online: false})];
        const host = build(loaded);

        refresh(loaded);

        ok(!host.querySelector('.view[data-view="ilumby8"]'), 'still no panel');
        host.remove();
    });
});

describe('a station that has stopped reporting', () => {
    it('keeps the day it did record', () => {
        // The chart is the whole reason the tab stays: a station that quit at
        // noon is exactly the one whose morning is worth looking at.
        const stale = entry('ILUMBY7', {online: false});
        const markup = index.renderStationView(stale);

        ok(markup.includes('panel-ilumby7'), 'the panel is still drawn');
        ok(markup.includes('trend'), 'and it still carries its chart');
    });

    it('shows no readings, rather than the last ones it published', () => {
        // A number sitting on the page is read as current. The bucket behind it
        // may be hours old, so it does not go up at all.
        const markup = index.renderStationView(entry('ILUMBY7', {online: false}));

        ok(!markup.includes('23.7'), 'not the temperature it last reported');
        ok(!markup.includes('7.1'), 'nor the wind');
        ok(markup.includes('—'), 'dashes instead');
    });

    it('is still reachable in the tab bar', () => {
        const markup = index.renderTabs([entry('ILUMBY7', {online: false})]);

        ok(markup.includes('offline'), 'and says why');
        ok(!markup.includes('disabled'), 'but can still be opened for its chart');
    });

    it('is closed off only when there is nothing to draw either', () => {
        const markup = index.renderTabs([entry('ILUMBY7', {online: false, day: null})]);
        ok(markup.includes('disabled'));
    });

    it('rebuilds the page when a day arrives for a station that had none', () => {
        const before = index.signature([entry('ILUMBY7', {day: null})]);
        const after = index.signature([entry('ILUMBY7')]);
        ok(before !== after, 'a chart appearing is a change of shape');
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
