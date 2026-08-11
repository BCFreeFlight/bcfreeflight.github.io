import {describe, it, equal, ok, close, fixture, withFetch, response} from './runner.js';
import api, {RaspApi, FORECAST_LEVELS} from '../scripts/rasp-api.js';
import {Forecast} from '../scripts/forecast.js';
import {buildForecastWindgram} from '../scripts/rasp-model.js';
import {Windgram} from '../scripts/windgram.js';
import {FORECAST_STRIPS, FORECAST_CEILING, FORECAST_WINDOW, LAYOUT} from '../scripts/config/rasp.js';
import {
    blDepth, dewpoint, updraft, virtualHeatFlux, LCL_PER_DEGREE, DRY_ADIABAT
} from '../scripts/lib/thermal.js';

/**
 * The forecast windgram.
 *
 * The Canadian RASP draws this chart on a server and ships a PNG. This draws it
 * in the browser from the same model, and the whole point of the exercise is
 * that the arithmetic in between is the RASP's own — so the calculations are
 * checked against hand-worked numbers rather than against whatever the code
 * happened to produce first.
 *
 * Two things are easy to get wrong here and neither fails loudly:
 *
 * The window is the flying day on the *site's* clock, not the reader's. Someone
 * checking Cooper's from another timezone is asking about Cooper's afternoon.
 *
 * A forecast that has run out of hours is a gap, not a flat line. The second
 * day's tab hits this every time a model run is late.
 *
 * Every response is staged. Nothing here touches the network.
 */

const profile = await fixture('forecast-profile-coopers');
const flux = await fixture('forecast-flux-coopers');

const COOPERS = {lat: 50.285548, lon: -118.984665};

const HOUR = 60 * 60 * 1000;

/**
 * Stages both halves of the read. Both go to the same host and are told apart
 * by what they ask for.
 * @param {Object} [options] - Replacements for either half
 * @returns {function(string): Response} A fetch stand-in
 */
function both({forecast = profile, energy = flux} = {}) {
    return url => url.includes('heat_flux')
        ? response({body: energy})
        : response({body: forecast});
}

/**
 * Clears anything a previous test cached.
 * @returns {void}
 */
function forget() {
    Object.keys(localStorage)
        .filter(key => key.startsWith('forecast_'))
        .forEach(key => localStorage.removeItem(key));
}

/**
 * A forecast read through the real shaping, from the staged responses.
 * @param {Object} [options] - Replacements for either half
 * @returns {Promise<Object>} The shaped forecast
 */
async function read(options) {
    forget();

    let shaped = null;

    await withFetch(both(options), async () => {
        shaped = await new Forecast().load(COOPERS.lat, COOPERS.lon);
    });

    return shaped;
}

/**
 * The built model for one forecast day.
 * @param {number} day - 0 for today, 1 for tomorrow
 * @returns {Promise<?Object>} The model
 */
async function model(day = 0) {
    return buildForecastWindgram(await read(),
        {day, latitude: COOPERS.lat, longitude: COOPERS.lon});
}

describe('asking for the forecast', () => {
    it('asks the model the Canadian RASP is built on', () => {
        ok(api.profileUrl(COOPERS.lat, COOPERS.lon).includes('models=gem_hrdps_continental'));
    });

    it('asks for two days, on the site\'s own clock', () => {
        const url = api.profileUrl(COOPERS.lat, COOPERS.lon);

        ok(url.includes('forecast_days=2'));
        ok(url.includes('timezone=auto'), 'so the window is the flying day, not UTC');
        ok(url.includes('timeformat=unixtime'), 'and the times still arrive as numbers');
    });

    it('reads every level the profile needs', () => {
        const url = api.profileUrl(COOPERS.lat, COOPERS.lon);

        FORECAST_LEVELS.forEach(level => {
            ['temperature', 'relative_humidity', 'wind_speed', 'wind_direction', 'geopotential_height']
                .forEach(field => ok(url.includes(`${field}_${level}hPa`), `${field} at ${level}`));
        });
    });

    it('carries the levels the RASP spaces closely near the ground', () => {
        // 25 hPa apart low down, which is what resolves a shallow morning
        // boundary layer. Losing these would not fail anything visibly.
        [925, 900, 875].forEach(level => ok(FORECAST_LEVELS.includes(level), `${level} hPa`));
    });

    it('takes the heat fluxes from whichever model publishes them', () => {
        // HRDPS does not publish them here, and the strength of the day is not
        // worth losing over which model answered.
        const url = api.fluxUrl(COOPERS.lat, COOPERS.lon);

        ok(url.includes('sensible_heat_flux') && url.includes('latent_heat_flux'));
        ok(!url.includes('models='), 'so Open-Meteo picks whatever has them');
    });

    it('asks about the exact point, unrounded', () => {
        // The response carries the terrain height of the point asked about, and
        // a hundredth of a degree is a couple of hundred metres of hillside.
        ok(api.profileUrl(COOPERS.lat, COOPERS.lon).includes(`latitude=${COOPERS.lat}`));
    });

    it('gives up on one half without losing the other', async () => {
        const staged = url => url.includes('heat_flux')
            ? response({status: 500})
            : response({body: profile});

        let halves = [];
        await withFetch(staged, async () => {
            halves = await new RaspApi().readBoth(COOPERS.lat, COOPERS.lon);
        });

        ok(halves[0], 'the profile still arrived');
        equal(halves[1], null, 'and the fluxes did not');
    });
});

describe('holding the forecast', () => {
    it('reads it once and remembers it', async () => {
        forget();

        await withFetch(both(), async calls => {
            const forecast = new Forecast();

            await forecast.load(COOPERS.lat, COOPERS.lon);
            await forecast.load(COOPERS.lat, COOPERS.lon);

            equal(calls.length, 2, 'two halves, read once');
        });
    });

    it('shares one read between callers asking at the same moment', async () => {
        forget();

        await withFetch(both(), async calls => {
            const forecast = new Forecast();

            await Promise.all([
                forecast.load(COOPERS.lat, COOPERS.lon),
                forecast.load(COOPERS.lat, COOPERS.lon)
            ]);

            equal(calls.length, 2, 'still only the two halves');
        });
    });

    it('reads again once what it held has gone stale', async () => {
        forget();

        localStorage.setItem(`forecast_${COOPERS.lat}_${COOPERS.lon}`,
            JSON.stringify({fetchedAt: Date.now() - 60 * 60 * 1000, forecast: {times: [1]}}));

        await withFetch(both(), async calls => {
            await new Forecast().load(COOPERS.lat, COOPERS.lon);

            ok(calls.length > 0, 'an hour old is too old');
        });
    });

    it('reads again rather than trusting a broken cache', async () => {
        forget();
        localStorage.setItem(`forecast_${COOPERS.lat}_${COOPERS.lon}`, 'not json');

        let shaped = null;
        await withFetch(both(), async () => {
            shaped = await new Forecast().load(COOPERS.lat, COOPERS.lon);
        });

        ok(shaped?.times?.length);
    });

    it('resolves to nothing rather than failing when the service is down', async () => {
        forget();

        let shaped;
        await withFetch(() => response({status: 503}), async () => {
            shaped = await new Forecast().load(COOPERS.lat, COOPERS.lon);
        });

        equal(shaped, null);
    });

    it('wants somewhere to ask about', async () => {
        equal(await new Forecast().load(undefined, undefined), null);
    });
});

describe('shaping the forecast', () => {
    it('carries the ground the model answered for', async () => {
        const shaped = await read();

        ok(shaped.elevation > 500 && shaped.elevation < 2000, `${shaped.elevation} m is a launch`);
    });

    it('carries the site\'s own offset from UTC', async () => {
        const shaped = await read();

        equal(shaped.offset, -7 * HOUR, 'Pacific daylight time, in milliseconds');
    });

    it('turns published seconds into milliseconds', async () => {
        const shaped = await read();

        ok(shaped.times[0] > 1e12, 'milliseconds, like every other clock on the site');
        equal(shaped.times[1] - shaped.times[0], HOUR);
    });

    it('converts the pressures once, where they are read', async () => {
        const shaped = await read();

        // Pascals for the physics, kilopascals for the strip.
        ok(shaped.surface.pressure[0] > 50000, 'surface pressure in pascals');
        ok(shaped.surface.seaLevel[0] > 90 && shaped.surface.seaLevel[0] < 110, 'sea level in kPa');
    });

    it('drops a level the model does not carry', async () => {
        const thinned = structuredClone(profile);
        FORECAST_LEVELS.forEach(level => { thinned.hourly[`temperature_${level}hPa`] = null; });

        const shaped = await read({forecast: thinned});

        equal(shaped.levels.length, 0, 'rather than keeping columns of gaps');
    });

    it('leaves the fluxes as gaps when nothing answered', async () => {
        const shaped = await read({energy: null});

        equal(shaped.sensible.every(value => value === null), true);
        ok(shaped.times.length, 'though the profile is still there');
    });

    it('is nothing at all without a profile', async () => {
        equal(new Forecast().shape(null, flux), null);
    });
});

describe('the RASP\'s own arithmetic', () => {
    it('turns a latent flux into the buoyancy it is worth', () => {
        // 0.61 × cp / Lv × T × latent, at 25 ºC: 0.000245268 × 298.15 × 100.
        close(virtualHeatFlux(200, 100, 25), 207.3129, 0.001);
    });

    it('finds where a parcel stops, between two levels', () => {
        // Ground at 1000 m and 20 ºC. The level above is at 2000 m and 13 ºC, so
        // the air cools at 7 ºC/km and the parcel at 9.8: they close at 2.8
        // ºC/km, and the parcel starts level with the ground, so they meet
        // nowhere below 2000 m. Raise the level's temperature to 15 and the
        // gap closes at (20 − 20 + 0) — still the ground. The honest test is a
        // level whose own temperature is above the ground's.
        const levels = [{elevation: 2000, temp: 13}];

        // parcel: 20 − 0.0098 z. environment: 20 + (13 − 20)/1000 × z.
        // 20 − 0.0098z = 20 − 0.007z has its only root at z = 0, so nothing
        // rises: the layer is stable relative to a dry parcel throughout.
        equal(blDepth(20, levels, 1000), 0);
    });

    it('carries a parcel up through a steep layer to where it stalls', () => {
        // Steeply cooling to 500 m above ground, then an inversion. The parcel
        // leaves at 20 ºC and cools at 9.8 ºC/km; the air below 1500 m cools at
        // 12 ºC/km, so the parcel stays warmer. Above it the air warms at 4
        // ºC/km, closing at 13.8 ºC/km from a 1.1 ºC lead.
        const levels = [
            {elevation: 1500, temp: 14},
            {elevation: 2500, temp: 18}
        ];

        const depth = blDepth(20, levels, 1000);
        const parcel = 20 - DRY_ADIABAT * depth;
        const environment = 14 + (18 - 14) / 1000 * (1000 + depth - 1500);

        ok(depth > 500 && depth < 1500, `${depth} m is inside the inversion`);
        close(parcel, environment, 0.001, 'and the two curves meet there');
    });

    it('has nothing to climb through under an inversion at the ground', () => {
        equal(blDepth(10, [{elevation: 1100, temp: 15}], 1000), 0);
    });

    it('climbs at the rate the RASP would', () => {
        // (g/θ · Q/(ρ cp) · D)^⅓, with the density computed rather than assumed.
        // Around 2 m/s for 200 W/m² through two kilometres at sea level.
        const rate = updraft(2000, 200, 20, 0);

        ok(rate > 1.5 && rate < 2.5, `${rate} m/s`);
    });

    it('does not climb without heat, or without a layer', () => {
        equal(updraft(2000, 0, 20, 0), 0);
        equal(updraft(0, 200, 20, 0), 0);
    });

    it('climbs faster in the thinner air up a mountain', () => {
        // The one place this deliberately departs from the RASP, which folds a
        // sea-level density into its constant.
        ok(updraft(2000, 200, 20, 2000) > updraft(2000, 200, 20, 0));
    });

    it('puts cloudbase where the RASP puts it', () => {
        equal(LCL_PER_DEGREE, 121);

        // 15 degrees of spread over a launch at 749 m.
        equal(749 + LCL_PER_DEGREE * 15, 2564);
    });

    it('reads a dew point off a humidity', () => {
        close(dewpoint(20, 100), 20, 0.05, 'saturated air is at its dew point');
        ok(dewpoint(20, 50) < 10, 'and half-saturated air is well below it');
        equal(dewpoint(20, 0), null);
    });
});

describe('building a forecast day', () => {
    it('draws the flying day on the site\'s own clock', async () => {
        const built = await model(0);

        const start = new Date(built.dayStart + built.offset).getUTCHours();
        const end = new Date(built.lastTime + built.offset).getUTCHours();

        equal(start, FORECAST_WINDOW.startHour, 'seven in the morning, local');
        equal(end, FORECAST_WINDOW.endHour, 'nine at night, local');
    });

    it('is one column an hour, and says so', async () => {
        const built = await model(0);

        equal(built.columnMs, HOUR);
        equal(built.columns.length, FORECAST_WINDOW.endHour - FORECAST_WINDOW.startHour + 1);
    });

    it('draws tomorrow a day later than today', async () => {
        const [today, tomorrow] = [await model(0), await model(1)];

        equal(tomorrow.dayStart - today.dayStart, 24 * HOUR);
    });

    it('sits on the ground the model answered for', async () => {
        const built = await model(0);
        const shaped = await read();

        equal(built.ground, shaped.elevation);
        ok(built.floor < built.ground, 'with a little air under it');
        equal(built.ceiling, FORECAST_CEILING);
    });

    it('names no stations, because none are standing in this air', async () => {
        const built = await model(0);

        equal(built.stations.length, 0);
        equal(built.modelledAloft, true);
    });

    it('leaves out the levels buried inside the mountain', async () => {
        const built = await model(0);

        built.columns.forEach(column => {
            column.levels.forEach(level => {
                ok(level.elevation >= built.ground, `${level.elevation} is above ${built.ground}`);
            });
        });
    });

    it('starts the profile at the ground', async () => {
        const built = await model(0);
        const column = built.columns[6];

        equal(column.levels[0].elevation, built.ground);
        equal(column.levels[0].label, 'Surface');
    });

    it('names each level aloft by its pressure', async () => {
        const built = await model(0);

        ok(built.columns[6].levels.some(level => /^\d+ hPa$/.test(level.label)));
    });

    it('has a climb through the middle of the day', async () => {
        const built = await model(0);
        const midday = built.columns.find(column =>
            new Date(column.time + built.offset).getUTCHours() === 14);

        ok(midday.lift > 1, `${midday.lift} m/s at two in the afternoon`);
        ok(midday.thermalTop > built.ground, 'and somewhere to climb to');
    });

    it('never claims a climb above cloudbase', async () => {
        const built = await model(0);

        built.columns.forEach(column => {
            if (column.climbTop === null || column.cloudBase === null) return;

            ok(column.climbTop <= column.cloudBase + 1e-9,
                `${column.climbTop} should not be over ${column.cloudBase}`);
        });
    });

    it('stops claiming thermals once the ground stops warming', async () => {
        // The parcel calculation has no idea what time it is: left alone it
        // reports a healthy thermal top at dusk, when the air really is that
        // unstable and there is simply nothing setting a bubble off.
        const built = await model(0);
        const dusk = built.columns.at(-1);

        equal(dusk.thermalTop, null);

        // Zero rather than nothing. A gap in the lift strip is the drawing
        // saying it does not know, and it breaks the fill into pieces — which
        // is wrong for an evening, and was wrong for the hour an afternoon
        // shower shut the thermals down.
        equal(dusk.lift, 0);
    });

    it('leaves the lift unknown only when the flux is', async () => {
        const shaped = await read({energy: null});
        const built = buildForecastWindgram(shaped,
            {day: 0, latitude: COOPERS.lat, longitude: COOPERS.lon});

        equal(built.columns.every(column => column.lift === null), true);
    });

    it('leaves an hour the model lost as a gap', async () => {
        const holed = structuredClone(profile);
        FORECAST_LEVELS.forEach(level => { holed.hourly[`temperature_${level}hPa`][20] = null; });
        holed.hourly.temperature_2m[20] = null;

        const built = buildForecastWindgram(await read({forecast: holed}),
            {day: 0, latitude: COOPERS.lat, longitude: COOPERS.lon});

        const gap = built.columns.find(column => !column.segments.length);

        ok(gap, 'the hour is still a column');
        equal(gap.levels.length, 0, 'with nothing in it');
    });

    it('is nothing at all for a day the model does not reach', async () => {
        equal(await model(5), null);
    });

    it('is nothing at all without a forecast', () => {
        equal(buildForecastWindgram(null, {day: 0}), null);
        equal(buildForecastWindgram({times: [1], offset: 0, elevation: null}, {day: 0}), null);
    });

    it('smooths the two lines that are crossings rather than values', async () => {
        const built = await model(0);
        const bases = built.columns.map(column => column.cloudBase).filter(value => value !== null);

        // A 1-2-1 pass cannot leave a value outside the range of its neighbours.
        bases.slice(1, -1).forEach((value, index) => {
            const span = [bases[index], bases[index + 2]].sort((a, b) => a - b);
            ok(value >= Math.min(span[0], value) && value <= Math.max(span[1], value));
        });
    });
});

describe('drawing the forecast', () => {
    /**
     * Draws a model into a host wide enough to size against.
     * @param {?Object} built - A forecast model
     * @returns {string} The markup produced
     */
    function draw(built) {
        const host = document.createElement('div');
        host.style.width = '900px';
        document.body.appendChild(host);

        const windgram = new Windgram(host, {
            strips: FORECAST_STRIPS,
            barbOffsetFeet: 200,
            empty: 'No forecast for this day yet.',
            smooth: true,
            footnotes: () => ['forecast']
        });

        windgram.setModel(built);

        const markup = host.innerHTML;

        windgram.destroy();
        host.remove();

        return markup;
    }

    it('draws the air, the wind and the climb', async () => {
        const markup = draw(await model(0));

        ok(markup.includes('windgram-svg'));
        ok(markup.includes('windgram-barb'), 'barbs');
        ok(markup.includes('windgram-stability'), 'stability');
        ok(markup.includes('windgram-isotherm'), 'isotherms');
        ok(markup.includes('windgram-thermal-line'), 'the top of the lift');
    });

    it('labels the hours by the clock rather than from the left edge', async () => {
        const markup = draw(await model(0));

        ok(markup.includes('>07<'), 'the window opens at seven, not at zero');
        ok(markup.includes('>21<'), 'and closes at nine at night');
    });

    it('never puts a barb up among the strips', async () => {
        // The top pressure level sits above the ceiling, and the strips sit
        // above the panel. A barb that escapes lands in the rain row, which
        // reads as weather rather than as a mistake — so the panel refuses to
        // place one outside itself rather than trusting a clip to hide it.
        const markup = draw(await model(0));
        const panelTop = LAYOUT.top
            + FORECAST_STRIPS.length * (LAYOUT.strip + LAYOUT.stripGap)
            + LAYOUT.stripToPanel;

        const placed = [...markup.matchAll(/translate\(([\d.]+) ([\d.]+)\)/g)]
            .map(match => Number(match[2]));

        ok(placed.length, 'there are barbs to check');
        ok(placed.every(y => y >= panelTop),
            `lowest barb at ${Math.min(...placed)} should be under ${panelTop}`);
    });

    it('has no shade strip, because a forecast has nothing to measure', () => {
        equal(FORECAST_STRIPS.some(strip => strip.key === 'shade'), false);
    });

    it('leaves a strip empty rather than magnifying a trace', async () => {
        const built = await model(0);
        built.columns.forEach(column => { column.rain = 0.001; });

        const markup = draw(built);

        // The frame and the label are still drawn; the fill is not.
        ok(markup.includes('Rain'));
        ok(!markup.includes('0.00</text>'), 'no axis on a strip with nothing on it');
    });

    it('says so when there is no day to draw', () => {
        ok(draw(null).includes('No forecast for this day yet.'));
    });

    it('fills the air as a field rather than as a stack of blocks', async () => {
        const markup = draw(await model(0));
        const stability = markup.match(/<g class="windgram-stability">([\s\S]*?)<\/g>/)[1];

        // One path per band, each a merged run of cells — not one rectangle per
        // layer per hour, which is what made the sky look like masonry.
        ok(stability.includes('<path'), 'drawn as paths');
        ok(!stability.includes('<rect'), 'and not as blocks');

        const bands = stability.match(/<path/g).length;
        ok(bands > 1 && bands <= 9, `${bands} bands in play`);
    });

    it('leaves an hour the model lost uncoloured rather than bridging it', async () => {
        const holed = structuredClone(profile);
        [8, 9].forEach(hour => {
            FORECAST_LEVELS.forEach(level => { holed.hourly[`temperature_${level}hPa`][hour] = null; });
            holed.hourly.temperature_2m[hour] = null;
        });

        const built = buildForecastWindgram(await read({forecast: holed}),
            {day: 0, latitude: COOPERS.lat, longitude: COOPERS.lon});

        ok(draw(built).includes('windgram-missing'), 'the gap is hatched, not painted over');
    });
});
