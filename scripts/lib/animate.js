import {TILE_TRANSITION_MS} from '../config/defaults.js';

/**
 * Moving a reading to its new value instead of swapping it.
 *
 * The stations are re-read every minute, and until now every tile changed by
 * replacing its own text: 20.4 became 21.1 between two frames, and the arrow
 * jumped from one bearing to another. A reading that moves is easier to catch
 * out of the corner of an eye than one that has already changed, which on a
 * screen at a launch is the whole point.
 *
 * Two kinds of movement, because there are two kinds of reading. A number
 * counts to its new value at its own precision — rainfall through hundredths,
 * humidity through whole percent — and a bearing turns, the short way, however
 * many times the wind has been round the compass since the page opened.
 *
 * Everything else swaps: a compass point, a band's wording, the dash that
 * stands in for a sensor a station does not carry. There is no halfway between
 * "Comfortable" and "Oppressive", and pretending otherwise would be worse than
 * the swap.
 */

// One animation per element. A refresh landing mid-count retargets from
// wherever the number has got to rather than starting again, so a tile cannot
// be left counting towards a value that has already been replaced.
const running = new Map();

// Where each turning element has actually got to, as a continuous angle rather
// than a compass bearing. See `shortestTurn`.
const angles = new WeakMap();

/**
 * Whether the reader has asked for less movement.
 *
 * Asked on every animation rather than once at load, because the setting can be
 * changed while the page is open — and the live page is open for hours.
 *
 * @returns {boolean} True when animation should be skipped
 */
export function reducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Decelerating, so a value arrives rather than stopping dead.
 * @param {number} progress - Linear progress, 0 to 1
 * @returns {number} Eased progress, 0 to 1
 */
function ease(progress) {
    return 1 - Math.pow(1 - progress, 3);
}

/**
 * Stops whatever this element was doing.
 * @param {Element} element - The element being animated
 * @returns {void}
 */
export function stop(element) {
    const movement = running.get(element);

    if (!movement) return;

    cancelAnimationFrame(movement.frame);
    running.delete(element);

    // Settled where it was abandoned rather than left hanging. A refresh
    // landing mid-count replaces the movement under it, and whoever was
    // waiting on the old one is waiting for a frame that will never be drawn.
    movement.give();
}

/**
 * Finishes everything that is moving, at once.
 *
 * Every reading lands on the value it was counting towards and its animation
 * settles, so anything waiting on one is not left waiting for a frame that is
 * not coming. Used by the tests, which have no interest in watching two seconds
 * pass for each of a dozen tiles, and by anything that needs the page to be
 * showing its readings right now rather than shortly.
 *
 * @returns {void}
 */
export function settle() {
    for (const [element, movement] of [...running]) {
        cancelAnimationFrame(movement.frame);
        running.delete(element);
        movement.land();
    }
}

// A hidden page stops being drawn, and a movement is drawn frame by frame: a
// tab switched away from mid-count freezes its tiles on a number that is on its
// way to a reading rather than on the reading. So everything lands the moment
// nobody is looking, and the page is only ever put away showing what its
// stations actually said.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) settle();
});

/**
 * Runs one element's animation, replacing any it was already running.
 *
 * Resolves when the last frame has been drawn, which is what lets a test await
 * the finished value instead of polling for it.
 *
 * @param {Element} element - The element being animated
 * @param {number} duration - Milliseconds the movement should take
 * @param {function(number): void} draw - Draws one frame, given eased progress
 * @returns {Promise<void>} Settles when the movement is finished
 */
function play(element, duration, draw) {
    stop(element);

    // Nothing to watch, or nobody who wants to watch it: land on the value.
    if (!(duration > 0) || reducedMotion()) {
        draw(1);
        return Promise.resolve();
    }

    return new Promise(resolve => {
        const started = performance.now();

        // The value it is moving from, drawn now rather than a frame from now,
        // so the element is never briefly showing neither reading.
        draw(0);

        const land = () => {
            draw(1);
            resolve();
        };

        const movement = {frame: 0, land, give: resolve};

        const frame = now => {
            const progress = Math.min((now - started) / duration, 1);

            if (progress >= 1) {
                running.delete(element);
                land();
                return;
            }

            draw(ease(progress));
            movement.frame = requestAnimationFrame(frame);
        };

        movement.frame = requestAnimationFrame(frame);
        running.set(element, movement);
    });
}

/**
 * The first number in a reading, and how it is written.
 *
 * A reading is rarely a bare number: it is "WSW 7.1 km/h", or "140" beside a
 * unit in its own element, or "1,987 ft". Only the number moves, so it has to
 * be found in the text rather than assumed to be all of it — and how it is
 * written has to come back with it, because the precision belongs to the
 * measurement. Rainfall counts through hundredths and humidity through whole
 * percent, and neither should be told that here.
 *
 * @param {?string} text - A reading, as it is written on the page
 * @returns {?Object} value, digits, grouped, index and length, or null
 */
export function figureIn(text) {
    const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text ?? '');

    if (!match) return null;

    const written = match[0];
    const point = written.indexOf('.');

    return {
        value: Number(written.replace(/,/g, '')),
        digits: point === -1 ? 0 : written.length - point - 1,
        // A thousands separator is part of how the reading reads, so a value
        // counting towards 1,987 must keep its comma on the way.
        grouped: written.includes(','),
        index: match.index,
        length: written.length
    };
}

/**
 * A reading with its number replaced, written the way the reading writes it.
 * @param {string} text - The reading to write into
 * @param {Object} figure - Where and how, from `figureIn`
 * @param {number} value - The number to write
 * @returns {string} The reading, with that number in place of its own
 */
export function withFigure(text, figure, value) {
    const written = figure.grouped
        ? value.toLocaleString(undefined,
            {minimumFractionDigits: figure.digits, maximumFractionDigits: figure.digits})
        : value.toFixed(figure.digits);

    return text.slice(0, figure.index) + written + text.slice(figure.index + figure.length);
}

/**
 * The run of text a reading is written in.
 *
 * A tile's value sits beside its unit, and the unit is its own element so it
 * can be styled down. Only the text is rewritten, so the unit survives being
 * counted past.
 *
 * @param {Element} element - The element holding the reading
 * @returns {?Text} The text node carrying it, or null when the element is empty
 */
function textIn(element) {
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return node;
    }

    return null;
}

/**
 * Writes a reading, counting to it when both readings are numbers.
 *
 * Swaps outright when there is nothing to count between: a station that has
 * started or stopped reporting moves between a number and a dash, and a compass
 * point or a band's wording was never a number to begin with. Also swaps when
 * the number has not moved, which is most refreshes — the loop ticks every
 * minute and a reading is a five-minute bucket, so four ticks in five carry the
 * value that is already on the page.
 *
 * @param {?Element} element - The element holding the reading
 * @param {string} text - The reading to show
 * @param {Object} [options] - duration, in milliseconds
 * @returns {Promise<void>} Settles when the reading is showing
 */
export function showValue(element, text, {duration = TILE_TRANSITION_MS} = {}) {
    if (!element) return Promise.resolve();

    const node = textIn(element);

    if (!node) {
        stop(element);
        element.textContent = text;
        return Promise.resolve();
    }

    const from = figureIn(node.textContent);
    const to = figureIn(text);

    if (!from || !to || from.value === to.value) {
        stop(element);
        node.textContent = text;
        return Promise.resolve();
    }

    const distance = to.value - from.value;

    return play(element, duration, progress => {
        node.textContent = progress === 1
            ? text
            : withFigure(text, to, from.value + distance * progress);
    });
}

/**
 * The angle to turn to, taking the short way round.
 *
 * A bearing wraps and an angle does not. Turning from 350º to 10º is twenty
 * degrees clockwise, but read as numbers it is three hundred and forty the
 * other way — which is what the arrow would do, once a refresh, every time the
 * wind sat near north. So the angle carried forward is continuous: it keeps
 * counting past 360 and below zero, and only ever moves by the shorter arc.
 *
 * @param {number} from - Where the element is now, as a continuous angle
 * @param {number} to - The bearing to end on
 * @returns {number} The continuous angle to turn to
 */
export function shortestTurn(from, to) {
    const difference = ((to - from) % 360 + 540) % 360 - 180;

    return from + difference;
}

/**
 * Where an element is pointing.
 *
 * Read back off the element the first time it is turned, so an arrow drawn at a
 * bearing by the initial render turns from there rather than snapping to zero
 * and winding up from underneath.
 *
 * @param {Element} element - A turning element
 * @returns {number} Its continuous angle
 */
function angleOf(element) {
    const known = angles.get(element);

    if (known !== undefined) return known;

    const written = /rotate\((-?[\d.]+)deg\)/.exec(element.style.transform ?? '');

    return written ? Number(written[1]) : 0;
}

/**
 * Turns an element to a bearing, the short way round.
 * @param {?Element} element - The element to turn
 * @param {number} degrees - The bearing to end on
 * @param {Object} [options] - duration, in milliseconds
 * @returns {Promise<void>} Settles when the element is pointing there
 */
export function showAngle(element, degrees, {duration = TILE_TRANSITION_MS} = {}) {
    if (!element || !Number.isFinite(degrees)) return Promise.resolve();

    const from = angleOf(element);
    const to = shortestTurn(from, degrees);

    angles.set(element, to);

    if (from === to) {
        stop(element);
        element.style.transform = `rotate(${to}deg)`;
        return Promise.resolve();
    }

    const distance = to - from;

    return play(element, duration, progress => {
        element.style.transform = `rotate(${from + distance * progress}deg)`;
    });
}
