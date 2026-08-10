/**
 * Showing and hiding a piece of a drawing.
 *
 * `element.hidden = false` is the obvious way to do this and it silently does
 * nothing here. `hidden` is a property of `HTMLElement`, and everything on
 * these charts is SVG: assigning it puts a stray property on the object without
 * touching the attribute, so the element stays exactly as hidden as it was. It
 * fails quietly, which is the worst way for it to fail — the crosshair on the
 * day charts sat visible at the left edge of every one of them for exactly this
 * reason, because the code that meant to hide it had never once worked.
 *
 * The attribute is the thing that matters, so the attribute is what this sets.
 */

/**
 * Shows or hides an element, SVG or HTML.
 * @param {?Element} element - The element to toggle
 * @param {boolean} shown - Whether it should be visible
 * @returns {void}
 */
export function reveal(element, shown) {
    if (!element) return;

    if (shown) element.removeAttribute('hidden');
    else element.setAttribute('hidden', '');
}
