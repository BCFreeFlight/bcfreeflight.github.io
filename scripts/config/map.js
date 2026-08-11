/**
 * The map behind the wind direction.
 *
 * Satellite imagery, from Esri's World Imagery layer. A drawn map was the first
 * attempt and it was the wrong picture: contour lines describe the ground
 * accurately and show you nothing you recognise. The photograph shows the
 * cleared slot in the trees, the road up to it and the treeline on either side,
 * which is what a pilot is actually picturing when they read a bearing off this
 * tile.
 *
 * No key, which is the other half of the reason for this layer. This site is
 * static, so any key would sit in the page source for anyone to lift and every
 * visitor would be spending the same quota.
 *
 * What it costs instead is attribution, which is a condition of use rather than
 * a courtesy, and staying inside a tile server's fair use: the frame is small,
 * the zoom is fixed, and each station asks for its tiles once per page load and
 * then reads them out of the browser's cache.
 */

// Close in: about five hundred metres across the frame, which at this latitude
// is what zoom 17 gives (roughly 0.76 m to the pixel, so 640 px is 490 m). A
// wider frame put the launch in a landscape and lost it there. This is the
// scale at which the contours separate, the treeline shows, and the slope the
// station stands on is the thing you are looking at rather than a fold in a
// map.
export const MAP_ZOOM = 17;

// The frame the mosaic is built for, centred in the tile and clipped by it.
// Generous on purpose: it is cheaper to cover a card wider than any phone than
// to measure one that has not been laid out yet.
export const MAP_FRAME = {width: 640, height: 320};

/**
 * The tile URL for a zoom, column and row.
 *
 * Row before column in the path, which is Esri's order and the reverse of every
 * other tile server's. The arithmetic that produces them is the same Web
 * Mercator scheme either way; only the URL is written back to front.
 *
 * @param {number} zoom - Tile zoom level
 * @param {number} x - Tile column
 * @param {number} y - Tile row
 * @returns {string} An absolute URL
 */
export function tileUrl(zoom, x, y) {
    return 'https://server.arcgisonline.com/ArcGIS/rest/services'
        + `/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`;
}

/** A condition of using the layer, and shown on the tile itself. */
export const MAP_CREDIT = 'Imagery © Esri, Maxar, Earthstar Geographics';
