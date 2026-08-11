/**
 * The palette, as the drawing code sees it.
 *
 * The colours themselves are in `styles/palette.css`, because half of them are
 * applied by stylesheet rules that JavaScript never touches. Keeping a second
 * copy here for the charts is how the wind line and the accent came to be the
 * same blue by coincidence rather than by declaration. So there is no second
 * copy: this reads the custom properties the browser has already resolved.
 *
 * A JSON file would have been the obvious shape for it, and is the wrong one.
 * It would have to be fetched, which makes every module that wants a colour
 * async, and it would leave the stylesheet needing its own copy anyway — which
 * is the problem, not the solution. Custom properties are already loaded before
 * the first module runs, and both sides read the one definition.
 */

// Live, so a property changed at runtime is picked up rather than frozen at
// import. Cheap to hold: it is a view onto the element, not a snapshot.
const root = getComputedStyle(document.documentElement);

/**
 * One colour, by the name it has in the palette.
 *
 * Throws rather than falling back, and deliberately. A silent fallback is how a
 * missing colour reaches production looking merely a bit off — and a colour
 * cannot resolve unless the palette stylesheet is missing entirely, in which
 * case the page has much larger problems than one chart line.
 *
 * @param {string} token - The custom property, without its leading dashes
 * @returns {string} A CSS colour
 */
export function colour(token) {
    const value = root.getPropertyValue(`--${token}`).trim();

    if (!value) {
        throw new Error(`No --${token} in the palette. Is styles/palette.css linked on this page?`);
    }

    return value;
}

/**
 * Several colours at once, in order.
 * @param {...string} tokens - Custom property names, without their dashes
 * @returns {string[]} The colours
 */
export function colours(...tokens) {
    return tokens.map(colour);
}
