import {describe, it, equal, ok, fixture, withFetch, response} from './runner.js';
import api, {SoundingApi, LEVELS} from '../scripts/sounding-api.js';
import {Sounding} from '../scripts/sounding.js';
import {STORAGE_KEYS} from '../scripts/config/defaults.js';

/**
 * The modelled air above the stations.
 *
 * Two rules are worth holding the line on here, because both are easy to break
 * by accident and neither shows up as a visible failure:
 *
 * Nothing asks for a forecast. The windgram draws the day that has happened, so
 * the window has to end at the hour we are in — not tomorrow, not this evening.
 *
 * Nothing modelled is used where something was measured. The profile is only
 * ever read above the top station, and the sunlight in the lift calculation is
 * always the pyranometer's; only the *share* of it that becomes heat is taken
 * from the model, because no weather station can report how wet the ground is.
 *
 * Every response is staged. Nothing here touches the network.
 */

const profile = await fixture('sounding-profile-coopers');
const surface = await fixture('sounding-surface-coopers');

const LUMBY = {lat: 50.284826, lon: -118.985672};
const FREEDOM = {lat: 50.266, lon: -118.963};

/**
 * Stages both halves of the read: the profile request and the surface request
 * go to the same host and are told apart by what they ask for.
 * @param {Object} [options] - Replacements for either half
 * @returns {function(string): Response} A fetch stand-in
 */
function both({sounding = profile, energy = surface} = {}) {
    return url => url.includes('heat_flux')
        ? response({body: energy})
        : response({body: sounding});
}

/**
 * Clears anything a previous test cached.
 * @returns {void}
 */
function forget() {
    Object.keys(localStorage)
        .filter(key => key.startsWith('sounding_'))
        .forEach(key => localStorage.removeItem(key));
}

describe('asking about the air aloft', () => {
    it('asks the model the Canadian RASP is built on', () => {
        ok(api.profileUrl(LUMBY.lat, LUMBY.lon).includes('models=gem_hrdps_continental'));
    });

    it('never asks for a forecast', () => {
        [api.profileUrl(LUMBY.lat, LUMBY.lon), api.surfaceUrl(LUMBY.lat, LUMBY.lon)].forEach(url => {
            ok(url.includes('past_hours=24'), 'a day behind');
            ok(url.includes('forecast_hours=1'), 'and no further ahead than this hour');
            ok(!url.includes('forecast_days'), 'never whole days of forecast');
        });
    });

    it('asks each level for its temperature and the height it is at', () => {
        const url = api.profileUrl(LUMBY.lat, LUMBY.lon);

        LEVELS.forEach(level => {
            ok(url.includes(`temperature_${level}hPa`), `${level} temperature`);
            // A pressure level is not a fixed altitude, so its height has to be
            // read for the hour rather than assumed.
            ok(url.includes(`geopotential_height_${level}hPa`), `${level} height`);
        });
    });

    it('asks for cloud, and asks the surface for the energy balance', () => {
        ok(api.profileUrl(LUMBY.lat, LUMBY.lon).includes('cloud_cover'));

        const url = api.surfaceUrl(LUMBY.lat, LUMBY.lon);
        ok(url.includes('sensible_heat_flux'));
        ok(url.includes('latent_heat_flux'));
        ok(url.includes('shortwave_radiation'), 'the model sunlight, only to take a ratio against');
        ok(!url.includes('models='), 'HRDPS does not publish fluxes here, so this one is blended');
    });

    it('needs no key, and sends two stations on one hillside to one square', () => {
        ok(!api.profileUrl(LUMBY.lat, LUMBY.lon).includes('apikey'));
        equal(api.profileUrl(LUMBY.lat, LUMBY.lon), api.profileUrl(FREEDOM.lat, FREEDOM.lon));
    });

    it('throws when the service will not answer', async () => {
        const client = new SoundingApi();

        await withFetch(() => response({status: 503, body: {}}), async () => {
            try {
                await client.read(client.profileUrl(LUMBY.lat, LUMBY.lon));
                ok(false, 'should have thrown');
            } catch (error) {
                ok(error.message.includes('503'));
            }
        });
    });

    it('keeps the half that answered when the other does not', async () => {
        const client = new SoundingApi();

        await withFetch(url => url.includes('heat_flux')
            ? response({status: 500, body: {}})
            : response({body: profile}), async () => {

            const [sounding, energy] = await client.readBoth(LUMBY.lat, LUMBY.lon);
            ok(sounding, 'the profile still arrived');
            equal(energy, null, 'and the failure is a null rather than a rejection');
        });
    });
});

describe('shaping the air aloft', () => {
    it('reads every level the model carries', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);

            equal(model.levels.length, LEVELS.length);
            equal(model.times.length, profile.hourly.time.length);
            equal(model.times[0], profile.hourly.time[0] * 1000, 'seconds became milliseconds');
            ok(model.levels.every(level => level.heights.length === model.times.length));
        });

        forget();
    });

    it('drops a level the model does not carry', async () => {
        forget();
        const service = new Sounding();
        const thin = structuredClone(profile);
        thin.hourly.temperature_600hPa = thin.hourly.temperature_600hPa.map(() => null);

        await withFetch(both({sounding: thin}), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);
            equal(model.levels.length, LEVELS.length - 1);
            ok(!model.levels.some(level => level.pressure === 600));
        });

        forget();
    });

    it('reads the profile only above the height it is asked about', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);
            const noon = model.times[12];

            // Silver Star, the top station, in metres.
            const above = service.profileAt(model, noon, 5453 * 0.3048);

            ok(above.length, 'there is air above the top station');
            ok(above.every(level => level.elevation > 5453 * 0.3048), 'and all of it is above');
            ok(above.every(level => level.modelled), 'marked as modelled, every one');

            const heights = above.map(level => level.elevation);
            equal(heights.join(), [...heights].sort((a, b) => a - b).join(), 'ascending');
        });

        forget();
    });

    it('says nothing about air below the stations', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);
            // Everything the model has is below this, so nothing comes back.
            equal(service.profileAt(model, model.times[12], 9000).length, 0);
        });

        forget();
    });

    it('has nothing to say about an hour it does not cover', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);
            const nextWeek = model.times.at(-1) + 7 * 86400000;

            equal(service.profileAt(model, nextWeek, 0).length, 0);
            equal(service.shareAt(model, nextWeek), null);
            equal(service.cloudAt(model, nextWeek), null);
        });

        forget();
    });
});

describe('how much sunlight becomes heat', () => {
    it('is a share rather than a flux, so the measured sunlight still rules', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);
            const shares = model.share.filter(value => value !== null);

            ok(shares.length, 'some hours have a share');
            ok(shares.every(share => share > 0 && share <= 0.9), 'and all of them are fractions');
        });

        forget();
    });

    it('says nothing at night, when the ground is losing heat', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);

            // The fixture's dark hours: no sunlight to take a share of, and a
            // flux running the other way as the ground cools.
            const dark = surface.hourly.shortwave_radiation
                .map((sun, i) => ({sun, share: model.share[i]}))
                .filter(hour => hour.sun === 0);

            ok(dark.length, 'the fixture has a night in it');
            ok(dark.every(hour => hour.share === null), 'and no share is claimed for any of it');
        });

        forget();
    });

    it('refuses a share it cannot believe', async () => {
        forget();
        const service = new Sounding();
        const absurd = structuredClone(surface);
        // A hundred times more heat than sunlight, which is not physics.
        absurd.hourly.sensible_heat_flux = absurd.hourly.sensible_heat_flux.map(() => 90000);
        absurd.hourly.shortwave_radiation = absurd.hourly.shortwave_radiation.map(() => 900);

        await withFetch(both({energy: absurd}), async () => {
            const model = await service.load(LUMBY.lat, LUMBY.lon);
            const shares = model.share.filter(value => value !== null);
            ok(shares.every(share => share <= 0.9), 'clamped to something possible');
        });

        forget();
    });

    it('carries on without the surface half entirely', async () => {
        forget();
        const service = new Sounding();

        await withFetch(url => url.includes('heat_flux')
            ? response({status: 500, body: {}})
            : response({body: profile}), async () => {

            const model = await service.load(LUMBY.lat, LUMBY.lon);
            ok(model.levels.length, 'the profile is still there');
            ok(model.share.every(share => share === null), 'and the share falls back to the constant');
        });

        forget();
    });
});

describe('holding on to the air aloft', () => {
    it('reads once and serves the rest from cache', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async calls => {
            await service.load(LUMBY.lat, LUMBY.lon);
            equal(calls.length, 2, 'one profile, one surface');
        });

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            ok(await service.load(LUMBY.lat, LUMBY.lon));
            equal(calls.length, 0);
        });

        forget();
    });

    it('costs one read for two stations in the same square', async () => {
        forget();
        const service = new Sounding();

        await withFetch(both(), async calls => {
            const models = await Promise.all([
                service.load(LUMBY.lat, LUMBY.lon),
                service.load(FREEDOM.lat, FREEDOM.lon)
            ]);

            ok(models.every(Boolean));
            equal(calls.length, 2, 'still just the one pair of requests');
        });

        forget();
    });

    it('reports nothing rather than an error when neither half answers', async () => {
        forget();
        const service = new Sounding();

        await withFetch(() => response({status: 500, body: {}}), async () => {
            equal(await service.load(LUMBY.lat, LUMBY.lon), null);
        });

        equal(localStorage.getItem(STORAGE_KEYS.sounding(50.3, -119)), null, 'and caches nothing');
        forget();
    });

    it('asks nothing without somewhere to ask about', async () => {
        forget();
        const service = new Sounding();

        await withFetch(() => { throw new Error('should not have been called'); }, async calls => {
            equal(await service.load(undefined, undefined), null);
            equal(calls.length, 0);
        });

        forget();
    });

    it('ignores a cache entry that has been corrupted', async () => {
        forget();
        localStorage.setItem(STORAGE_KEYS.sounding(50.3, -119), 'not json at all');
        const service = new Sounding();

        await withFetch(both(), async calls => {
            ok(await service.load(LUMBY.lat, LUMBY.lon));
            equal(calls.length, 2);
        });

        forget();
    });
});
