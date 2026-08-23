import {describe, it, equal, ok, close} from './runner.js';
import {
    figureIn, withFigure, shortestTurn, showValue, showAngle, settle, stop, reducedMotion
} from '../scripts/lib/animate.js';
import {TILE_TRANSITION_MS} from '../scripts/config/defaults.js';

/**
 * Readings that move to their new value.
 *
 * The arithmetic is tested on its own, because that is where a reading gets
 * written wrong: a bearing that turns the long way round, a rainfall that loses
 * its hundredths, a figure spliced into the middle of the wording beside it.
 * The movement itself is tested through the DOM at a duration short enough that
 * a suite is not spent watching it.
 */

/**
 * An element holding a reading, the way the pages write one.
 * @param {string} html - The tile's contents
 * @returns {HTMLElement} A detached element
 */
function tile(html) {
    const element = document.createElement('p');
    element.innerHTML = html;
    return element;
}

describe('finding the figure in a reading', () => {
    it('reads a bare number', () => {
        const figure = figureIn('23.7');
        equal(figure.value, 23.7);
        equal(figure.digits, 1);
        equal(figure.index, 0);
        equal(figure.length, 4);
    });

    it('keeps the precision the measurement is written at', () => {
        // Rainfall counts through hundredths and humidity through whole
        // percent. Neither is told so here: it is read off the reading.
        equal(figureIn('0.00').digits, 2);
        equal(figureIn('35').digits, 0);
        equal(figureIn('-1.91').digits, 2);
    });

    it('finds a figure with wording around it', () => {
        const figure = figureIn('WSW 7.1 km/h');
        equal(figure.value, 7.1);
        equal(figure.index, 4);
        equal(figure.length, 3);
    });

    it('reads a negative reading as negative', () => {
        equal(figureIn('-2.47').value, -2.47);
    });

    it('reads a grouped figure as one number', () => {
        // "1,987 ft" is one thousand nine hundred and eighty-seven, not one.
        const figure = figureIn('1,987 ft');
        equal(figure.value, 1987);
        equal(figure.grouped, true);
        equal(figure.length, 5);
    });

    it('has nothing to offer where there is no figure', () => {
        equal(figureIn('WSW'), null);
        equal(figureIn('—'), null);
        equal(figureIn('Loading...'), null);
        equal(figureIn(''), null);
        equal(figureIn(null), null);
    });
});

describe('writing a figure back into a reading', () => {
    it('leaves the wording around it alone', () => {
        const text = 'WSW 7.1 km/h';
        equal(withFigure(text, figureIn(text), 5.4), 'WSW 5.4 km/h');
    });

    it('writes it at the precision the reading uses', () => {
        equal(withFigure('0.00', figureIn('0.00'), 0.125), '0.13');
        equal(withFigure('35', figureIn('35'), 35.6), '36');
    });

    it('keeps a grouped figure grouped on the way', () => {
        equal(withFigure('1,987 ft', figureIn('1,987 ft'), 1500), '1,500 ft');
    });

    it('writes a negative figure as one', () => {
        equal(withFigure('-1.91', figureIn('-1.91'), -2.5), '-2.50');
    });
});

describe('turning the short way round', () => {
    it('goes forwards past north rather than back around the compass', () => {
        // The one this exists for. Read as numbers, 350 to 10 is 340 degrees
        // backwards; as a bearing it is twenty forwards.
        equal(shortestTurn(350, 10), 370);
    });

    it('goes backwards past north the same way', () => {
        equal(shortestTurn(10, 350), -10);
    });

    it('keeps counting rather than resetting to a bearing', () => {
        // Every time round the compass adds a turn. An arrow that has been
        // round three times is at 1,090 degrees, and turning it to 100 must not
        // unwind it through everywhere it has already been.
        equal(shortestTurn(1090, 100), 1180);
    });

    it('takes either way round a half turn without flinching', () => {
        equal(Math.abs(shortestTurn(0, 180) - 0), 180);
    });

    it('stays put when the wind has not moved', () => {
        equal(shortestTurn(238, 238), 238);
        equal(shortestTurn(598, 238), 598);
    });
});

describe('counting a reading to its new value', () => {
    it('arrives at the new reading', async () => {
        const element = tile('20.0');
        await (showValue(element, '21.0', {duration: 20}));
        equal(element.textContent, '21.0');
    });

    it('shows the value it is counting from before it sets off', () => {
        // Drawn now rather than a frame from now, so the tile is never briefly
        // showing neither reading.
        const element = tile('20.0');

        showValue(element, '21.0', {duration: 10000});
        equal(element.textContent, '20.0');

        stop(element);
    });

    it('passes through the values between', async () => {
        // Drawn frame by frame rather than set once at each end. Watched until
        // the tenth on the page actually changes rather than at a fixed frame,
        // because how far two seconds of counting has got after two frames
        // depends on how busy the machine running this is.
        const element = tile('20.0');
        const movement = showValue(element, '21.0', {duration: 400});

        let partway = 20.0;

        for (let frame = 0; frame < 60 && partway === 20.0; frame++) {
            await new Promise(requestAnimationFrame);
            partway = Number(element.textContent);
        }

        stop(element);
        await movement;

        ok(partway > 20.0 && partway < 21.0, `reached ${partway}, between the two`);
    });

    it('lets go of a movement that is abandoned', async () => {
        // Whoever was waiting on it is waiting for a frame that will never be
        // drawn, so stopping settles it where it stands.
        const element = tile('20.0');
        const movement = showValue(element, '30.0', {duration: 10000});

        stop(element);
        await movement;
    });

    it('keeps the wording and the unit around it', async () => {
        const element = tile('7.1<span class="unit">km/h</span>');
        await (showValue(element, '9.4', {duration: 20}));

        equal(element.querySelector('.unit').textContent, 'km/h', 'the unit is still there');
        equal(element.textContent, '9.4km/h');
    });

    it('counts the figure inside a fuller reading', async () => {
        const element = tile('WSW 7.1 km/h');
        await (showValue(element, 'W 9.4 km/h', {duration: 20}));
        equal(element.textContent, 'W 9.4 km/h');
    });

    it('swaps a reading there is nothing to count between', async () => {
        const dash = tile('23.7');
        await (showValue(dash, '—', {duration: 20}));
        equal(dash.textContent, '—', 'a sensor that stopped reporting');

        const back = tile('—');
        await (showValue(back, '23.7', {duration: 20}));
        equal(back.textContent, '23.7', 'and one that started');

        const words = tile('WSW');
        await (showValue(words, 'NNE', {duration: 20}));
        equal(words.textContent, 'NNE', 'a compass point was never a number');
    });

    it('does nothing at all when the reading has not changed', async () => {
        // Four refreshes in five, because the loop ticks every minute and a
        // reading is a five-minute bucket. Counting from a value to itself
        // would leave the tiles permanently in motion.
        const element = tile('23.7');
        await (showValue(element, '23.7', {duration: 10000}));
        equal(element.textContent, '23.7', 'landed rather than started');
    });

    it('retargets when a refresh lands mid-count', async () => {
        const element = tile('20.0');

        showValue(element, '30.0', {duration: 10000});
        await (showValue(element, '21.0', {duration: 20}));

        equal(element.textContent, '21.0', 'the newer reading wins');
    });

    it('writes into an empty tile rather than counting from nothing', async () => {
        const element = tile('');
        await (showValue(element, '23.7', {duration: 20}));
        equal(element.textContent, '23.7');
    });

    it('has nothing to write into when there is no tile', async () => {
        await (showValue(null, '23.7', {duration: 20}));
    });
});

describe('turning an arrow to a new bearing', () => {
    /**
     * @param {HTMLElement} element - A turned element
     * @returns {number} Where it is pointing, in degrees
     */
    const angle = element => Number(/rotate\((-?[\d.]+)deg\)/.exec(element.style.transform)[1]);

    it('arrives pointing the new way', async () => {
        const element = tile('navigation');
        element.style.transform = 'rotate(90deg)';

        await (showAngle(element, 180, {duration: 20}));
        equal(angle(element), 180);
    });

    it('starts from where it was already pointing', async () => {
        // The initial render writes a bearing into the markup. An arrow that
        // ignored it would snap to zero and wind up from underneath.
        const element = tile('navigation');
        element.style.transform = 'rotate(238deg)';

        showAngle(element, 240, {duration: 10000});
        close(angle(element), 238, 1);

        stop(element);
    });

    it('takes the short way past north', async () => {
        const element = tile('navigation');
        element.style.transform = 'rotate(350deg)';

        await (showAngle(element, 10, {duration: 20}));

        // 370, not 10: the same bearing, reached by turning twenty degrees
        // forwards rather than three hundred and forty back.
        equal(angle(element), 370);
        equal(((angle(element) % 360) + 360) % 360, 10, 'and it is pointing the right way');
    });

    it('keeps turning the same way through several refreshes', async () => {
        const element = tile('navigation');
        element.style.transform = 'rotate(0deg)';

        for (const bearing of [90, 180, 270, 0, 90]) {
            await (showAngle(element, bearing, {duration: 20}));
        }

        equal(angle(element), 450, 'one and a quarter turns, all of it forwards');
    });

    it('stays put when the wind has not moved', async () => {
        const element = tile('navigation');
        element.style.transform = 'rotate(238deg)';

        await (showAngle(element, 238, {duration: 10000}));
        equal(angle(element), 238);
    });

    it('ignores a bearing that is not one', async () => {
        const element = tile('navigation');
        element.style.transform = 'rotate(90deg)';

        await (showAngle(element, NaN, {duration: 20}));
        equal(angle(element), 90, 'left where it was');
    });
});

describe('landing everything at once', () => {
    it('finishes every reading that is still moving', async () => {
        const speed = tile('20.0');
        const arrow = tile('navigation');
        arrow.style.transform = 'rotate(0deg)';

        const movements = Promise.all([
            showValue(speed, '30.0', {duration: 10000}),
            showAngle(arrow, 90, {duration: 10000})
        ]);

        settle();
        await movements;

        equal(speed.textContent, '30.0');
        ok(arrow.style.transform.includes('rotate(90deg)'));
    });

    it('is quiet when nothing is moving', () => {
        settle();
        settle();
    });
});

describe('a reader who has asked for less movement', () => {
    it('is answered from the setting each time it is asked', () => {
        // Asked per animation rather than once at load, because the live page
        // is open for hours and the setting can change under it.
        equal(typeof reducedMotion(), 'boolean');
    });
});

describe('how long a tile takes', () => {
    it('is stated once, where it can be changed', () => {
        equal(TILE_TRANSITION_MS, 2000);
    });
});
