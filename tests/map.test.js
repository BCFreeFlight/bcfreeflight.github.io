import {describe, it, equal, ok, close, fixture} from './runner.js';
import {mosaic, tileFor, TILE} from '../scripts/lib/tiles.js';
import {MAP_FRAME, MAP_ZOOM, MAP_CREDIT, tileUrl} from '../scripts/config/map.js';
import index from '../scripts/index.js';

/**
 * The satellite tile behind the wind direction.
 *
 * A bearing is an abstraction until you can see what it points at, so the
 * direction tile carries a photograph of the ground the station stands on,
 * centred on the station's own coordinates.
 *
 * Nothing here fetches a tile, and that is deliberate rather than incidental:
 * the markup carries an empty frame and the images are put in afterwards, so a
 * test that mounts a station panel does not quietly start calling out to a tile
 * server. The frame is checked here; the arithmetic that fills it is checked
 * against known values below.
 */

const coopers = (await fixture('current-ILUMBY7')).observations[0];

/**
 * The frame a mosaic is built for, at the size the page uses.
 * @param {Object} [options] - Overrides for the centre and the zoom
 * @returns {Object[]} Tiles
 */
function frame({latitude = 50.284826, longitude = -118.985672, zoom = MAP_ZOOM} = {}) {
    return mosaic({
        latitude, longitude, zoom, url: tileUrl,
        width: MAP_FRAME.width, height: MAP_FRAME.height
    });
}

describe('placing a coordinate on the tile grid', () => {
    it('puts the prime meridian at the equator in the middle of the world', () => {
        const centre = tileFor(0, 0, 1);

        equal(centre.x, 1, 'halfway across two tiles');
        equal(centre.y, 1, 'and halfway down them');
    });

    it('counts columns east and rows south', () => {
        // Web Mercator starts at the top left, which is the north-west corner.
        const northwest = tileFor(60, -120, 4);
        const southeast = tileFor(-10, 60, 4);

        ok(northwest.x < southeast.x, 'west is left of east');
        ok(northwest.y < southeast.y, 'north is above south');
    });

    it('agrees with the tile Cooper\'s actually falls in', () => {
        // Checked against the published slippy-map arithmetic rather than
        // against itself: at zoom 17 the launch is in tile 22214/44290.
        const {x, y} = tileFor(50.284826, -118.985672, 17);

        equal(Math.floor(x), 22214);
        equal(Math.floor(y), 44290);
    });

    it('stretches towards the poles, as the projection does', () => {
        // Equal steps of latitude are not equal steps up the map. Rows count
        // southwards, so going north is a fall in y and the comparison is
        // between the sizes of those falls.
        const rows = [0, 20, 40, 60].map(latitude => tileFor(latitude, 0, 8).y);
        const steps = rows.slice(1).map((row, index) => Math.abs(row - rows[index]));

        steps.slice(1).forEach((step, index) =>
            ok(step > steps[index], `${step} is a longer step than ${steps[index]}`));
    });
});

describe('covering a frame with tiles', () => {
    it('asks for enough to fill it', () => {
        const tiles = frame();
        const covered = tiles.reduce((total, tile) => total + TILE * TILE, 0);

        ok(covered >= MAP_FRAME.width * MAP_FRAME.height, 'no bare corner');
    });

    it('asks for no more than it needs', () => {
        // A first cut of this ringed the frame with spares and requested
        // thirty-five tiles to cover twelve tiles' worth of frame. Every one of
        // them is a request to somebody else's server.
        const needed = (Math.ceil(MAP_FRAME.width / TILE) + 1) * (Math.ceil(MAP_FRAME.height / TILE) + 1);

        ok(frame().length <= needed, `${frame().length} tiles, at most ${needed}`);
    });

    it('leaves no tile entirely outside the frame', () => {
        frame().forEach(tile => {
            ok(tile.left + TILE > 0 && tile.left < MAP_FRAME.width, `column at ${tile.left}`);
            ok(tile.top + TILE > 0 && tile.top < MAP_FRAME.height, `row at ${tile.top}`);
        });
    });

    it('lays them out edge to edge', () => {
        const lefts = [...new Set(frame().map(tile => tile.left))].sort((a, b) => a - b);

        lefts.slice(1).forEach((left, index) =>
            close(left - lefts[index], TILE, 1e-6, 'no seam and no overlap'));
    });

    it('puts the station in the middle of the frame', () => {
        const centre = tileFor(50.284826, -118.985672, MAP_ZOOM);
        const tiles = frame();

        // The tile the station is in, and where the station sits inside it.
        const home = tiles.find(tile =>
            tile.url === tileUrl(MAP_ZOOM, Math.floor(centre.x), Math.floor(centre.y)));

        ok(home, 'the station\'s own tile was asked for');
        close(home.left + (centre.x - Math.floor(centre.x)) * TILE, MAP_FRAME.width / 2, 1e-6);
        close(home.top + (centre.y - Math.floor(centre.y)) * TILE, MAP_FRAME.height / 2, 1e-6);
    });

    it('wraps around the date line rather than asking for a tile that is not there', () => {
        const tiles = mosaic({
            latitude: 0, longitude: 179.99, zoom: 4, url: (zoom, x, y) => `${x},${y}`,
            width: MAP_FRAME.width, height: MAP_FRAME.height
        });

        tiles.forEach(tile => {
            const [x, y] = tile.url.split(',').map(Number);
            ok(x >= 0 && x < 16, `column ${x} is on the map`);
            ok(y >= 0 && y < 16, `row ${y} is on the map`);
        });
    });

    it('asks for nothing off the top or bottom of the world', () => {
        // Mercator never reaches the poles, so the rows simply run out.
        const tiles = mosaic({
            latitude: 85, longitude: 0, zoom: 2, url: (zoom, x, y) => `${x},${y}`,
            width: MAP_FRAME.width, height: MAP_FRAME.height
        });

        tiles.forEach(tile => {
            const row = Number(tile.url.split(',')[1]);
            ok(row >= 0 && row < 4, `row ${row} exists`);
        });
    });
});

describe('the tile server', () => {
    it('writes the row before the column, which is Esri\'s order', () => {
        equal(tileUrl(17, 22213, 44289),
            'https://server.arcgisonline.com/ArcGIS/rest/services'
            + '/World_Imagery/MapServer/tile/17/44289/22213');
    });

    it('shows about five hundred metres across the frame', () => {
        // The scale the launch itself fills the tile at. Web Mercator's metres
        // per pixel, at Cooper's latitude.
        const metresPerPixel = 156543.03392 * Math.cos(50.284826 * Math.PI / 180) / 2 ** MAP_ZOOM;
        const across = MAP_FRAME.width * metresPerPixel;

        ok(across > 400 && across < 600, `${Math.round(across)} m across`);
    });
});

describe('the frame in the wind tile', () => {
    it('is centred on the station\'s own coordinates', () => {
        const markup = index.renderWindMap(coopers);

        ok(markup.includes(`data-latitude="${coopers.lat}"`), markup);
        ok(markup.includes(`data-longitude="${coopers.lon}"`), markup);
    });

    it('is centred on the launch instead, when the site places one', () => {
        // The one thing on the page that is not the instrument's answer. The
        // station is sited where it can be serviced; the launch is where people
        // take off from, and it is the launch that should be in the frame.
        const launch = {start: 100, end: 144, latitude: 50.2856, longitude: -118.985967};
        const markup = index.renderWindMap(coopers, launch);

        ok(markup.includes('data-latitude="50.2856"'), markup);
        ok(markup.includes('data-longitude="-118.985967"'), markup);
        ok(!markup.includes(`data-latitude="${coopers.lat}"`), 'and not the station');
    });

    it('falls back to the station when the launch names no coordinates', () => {
        const markup = index.renderWindMap(coopers, {start: 100, end: 144, latitude: null, longitude: null});

        ok(markup.includes(`data-latitude="${coopers.lat}"`), markup);
    });

    it('carries the attribution the imagery is used under', () => {
        ok(index.renderWindMap(coopers).includes(MAP_CREDIT));
    });

    it('holds no images until something paints them', () => {
        // The reason a test can mount a station panel without calling out.
        ok(!index.renderWindMap(coopers).includes('<img'));
    });

    it('is left out entirely by a station that reports no position', () => {
        equal(index.renderWindMap({}), '');
        equal(index.renderWindMap(null), '');
        equal(index.renderWindMap({lat: 50.28, lon: null}), '');
        equal(index.renderWindMap({lat: 'somewhere', lon: -118.98}), '');
    });

    it('fills a frame once and leaves it alone after that', () => {
        // Painted with a stub source, because a detached image still fetches:
        // what is being checked is that the second pass is a no-op, since a
        // refresh every minute must not re-request the ground.
        const blank = () => 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
        const host = document.createElement('div');
        host.innerHTML = index.renderWindMap(coopers);

        index.paintMaps(host, blank);
        const first = host.querySelectorAll('.wind-map-frame img').length;

        index.paintMaps(host, blank);
        const second = host.querySelectorAll('.wind-map-frame img').length;

        ok(first > 0, 'the first pass filled it');
        equal(second, first, 'and the second changed nothing');
    });
});
