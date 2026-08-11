/**
 * A map, assembled out of tiles, with nothing to sign up for.
 *
 * Every static-image map service wants an API key, and a key on a static site
 * is a key in the page source: public, rate-limited against everyone at once,
 * and one billing change away from a blank tile. Tiles need none of that. A
 * slippy map is just a pyramid of 256-pixel squares addressed by zoom, column
 * and row, so a handful of `img` elements laid out on a grid *is* the map.
 *
 * The arithmetic is the Web Mercator projection every tile server shares, which
 * is why any of them can be swapped in by changing a URL template and nothing
 * else.
 */

// The edge of a tile, in pixels. Fixed by the scheme rather than chosen.
export const TILE = 256;

/**
 * Where a coordinate falls on the tile grid, tile numbers and fractions alike.
 *
 * The fraction is the part that matters: a station is almost never on a tile
 * boundary, and the offset within its tile is what decides how far the mosaic
 * has to be nudged to put that station in the middle of the frame.
 *
 * @param {number} latitude - Degrees north
 * @param {number} longitude - Degrees east
 * @param {number} zoom - Tile zoom level
 * @returns {Object} x and y, in fractional tiles
 */
export function tileFor(latitude, longitude, zoom) {
    const scale = 2 ** zoom;
    const radians = latitude * Math.PI / 180;

    return {
        x: (longitude + 180) / 360 * scale,
        // The Mercator stretch: a degree of latitude covers less ground on the
        // map the further north it is.
        y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * scale
    };
}

/**
 * The tiles that cover a frame of a given size, centred on a coordinate.
 *
 * Exactly the ones the frame shows, and no ring of spares around them: each one
 * is a request to someone else's tile server, and a first cut of this asked for
 * thirty-five to cover a frame twelve tiles wide.
 *
 * @param {Object} options - centre, zoom and frame
 * @param {number} options.latitude - Degrees north
 * @param {number} options.longitude - Degrees east
 * @param {number} options.zoom - Tile zoom level
 * @param {number} options.width - Frame width, in pixels
 * @param {number} options.height - Frame height, in pixels
 * @param {function(number, number, number): string} options.url - Tile URL from z, x, y
 * @returns {Object[]} One entry per tile: url, left and top, in pixels
 */
export function mosaic({latitude, longitude, zoom, width, height, url}) {
    const centre = tileFor(latitude, longitude, zoom);
    const scale = 2 ** zoom;

    // Where the centre tile's top-left corner lands once the station is in the
    // middle of the frame.
    const originLeft = width / 2 - (centre.x - Math.floor(centre.x)) * TILE;
    const originTop = height / 2 - (centre.y - Math.floor(centre.y)) * TILE;

    // The first and last tile that any part of the frame falls on. A tile in
    // column c covers `origin + c * TILE` to one tile further right, so it is
    // worth asking for only while some of that is still inside the frame.
    const span = (origin, extent) => ({
        from: Math.ceil(-origin / TILE) - 1,
        to: Math.ceil((extent - origin) / TILE) - 1
    });

    const columns = span(originLeft, width);
    const rows = span(originTop, height);

    const tiles = [];

    for (let row = rows.from; row <= rows.to; row++) {
        for (let column = columns.from; column <= columns.to; column++) {
            const x = Math.floor(centre.x) + column;
            const y = Math.floor(centre.y) + row;

            // Off the top or bottom of the world there is no tile to ask for.
            // East and west wrap, because the map does.
            if (y < 0 || y >= scale) continue;

            tiles.push({
                url: url(zoom, ((x % scale) + scale) % scale, y),
                left: originLeft + column * TILE,
                top: originTop + row * TILE
            });
        }
    }

    return tiles;
}
