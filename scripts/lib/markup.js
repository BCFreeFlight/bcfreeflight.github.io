/**
 * Text on its way into markup.
 *
 * Station names come from `sites.json` and readings come from an API, so both
 * are outside this codebase and neither can be trusted to contain no angle
 * brackets. Everything the site builds is built by interpolating strings, which
 * makes this the one guard between that data and the document.
 */

const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

/**
 * Escapes text bound for markup.
 * @param {*} value - Raw text
 * @returns {string} Text safe to interpolate
 */
export function escape(value) {
    return String(value).replace(/[&<>"']/g, character => ENTITIES[character]);
}
