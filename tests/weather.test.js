import {describe, it, equal, ok, close, fixture} from './runner.js';
import weather, {isFresh} from '../scripts/weather.js';
import * as readings from '../scripts/readings.js';
import {observationFrom} from '../scripts/config/series.js';

/**
 * The readings, and what the site says they mean.
 *
 * Everything here runs against captured responses from the three real stations,
 * which between them cover the cases that matter: one reports no pressure, one
 * reports no UV or sunlight, and they sit at three different heights.
 *
 * A reading is the newest five-minute bucket of a station's day, read the way
 * the site reads it, so these are the same numbers the tiles show.
 */

const buckets = {};
const observations = {};

for (const id of ['ILUMBY7', 'ILUMBY8', 'IVERNO71']) {
    buckets[id] = (await fixture(`day-${id}`)).observations.at(-1);
    observations[id] = observationFrom(buckets[id]);
}

const coopers = observations.ILUMBY7;   // 3,466 ft — no pressure sensor
const park = observations.ILUMBY8;      // 1,624 ft — the valley floor
const silverStar = observations.IVERNO71; // 5,453 ft — no UV or solar sensor

// Heights are the site's own, in metres, exactly as sites.json states them: a
// reading does not carry one.
const METRES = {ILUMBY7: 1056.4, ILUMBY8: 495.0, IVERNO71: 1662.1};

/**
 * A station entry, as the pages hand one around.
 * @param {string} id - The Weather Underground station id
 * @param {string} shortName - The name a lapse segment uses
 * @returns {Object} station, observation and online
 */
function entry(id, shortName) {
    return {
        station: {shortName, coordinates: {elevation: METRES[id]}},
        observation: observations[id],
        online: true
    };
}

describe('what a five-minute bucket says', () => {
    const bucket = buckets.ILUMBY7;

    it('reads the average, and the peak for a gust', () => {
        const reading = observationFrom(bucket);
        equal(reading.uk_hybrid.temp, bucket.uk_hybrid.tempAvg);
        equal(reading.uk_hybrid.dewpt, bucket.uk_hybrid.dewptAvg);
        equal(reading.uk_hybrid.windSpeed, bucket.uk_hybrid.windspeedAvg);
        // An average gust is not a gust.
        equal(reading.uk_hybrid.windGust, bucket.uk_hybrid.windgustHigh);
        equal(reading.uk_hybrid.heatIndex, bucket.uk_hybrid.heatindexAvg);
        equal(reading.uk_hybrid.windChill, bucket.uk_hybrid.windchillAvg);
    });

    it('knows which readings are not nested and which are', () => {
        // The trap: the direction sits at the top level of a bucket while the
        // speed beside it is inside uk_hybrid. Getting the pair backwards
        // leaves both undefined and both tiles reading as missing.
        const reading = observationFrom(bucket);
        equal(reading.winddir, bucket.winddirAvg);
        equal(reading.humidity, bucket.humidityAvg);
        equal(reading.uv, bucket.uvHigh);
        equal(reading.solarRadiation, bucket.solarRadiationHigh);
        equal(reading.uk_hybrid.windSpeed, bucket.uk_hybrid.windspeedAvg);
    });

    it('carries the moment and the place it was read at', () => {
        const reading = observationFrom(bucket);
        equal(reading.obsTimeUtc, '2026-08-10T19:49:47Z');
        equal(reading.stationID, 'ILUMBY7');
        equal(reading.lat, bucket.lat);
        equal(reading.lon, bucket.lon);
    });

    it('does not invent an elevation', () => {
        // A bucket does not carry one, and quietly filling one in would hide
        // every place that still reaches for it.
        equal(observationFrom(bucket).uk_hybrid.elev, undefined);
    });

    it('leaves out a sensor the station does not carry', () => {
        equal(observationFrom(buckets.ILUMBY7).uk_hybrid.pressure, null, 'no barometer');
        equal(observationFrom(buckets.IVERNO71).uv, null, 'no UV sensor');
        equal(observationFrom(buckets.IVERNO71).solarRadiation, null);
        equal(observationFrom(buckets.ILUMBY8).uk_hybrid.pressure, 956.89);
    });

    it('has nothing to say about a bucket that is not there', () => {
        equal(observationFrom(null), null);
        equal(observationFrom(undefined), null);
    });

    it('holds its shape for a bucket with no measurements in it', () => {
        const bare = observationFrom({epoch: 1});
        equal(bare.uk_hybrid.temp, undefined, 'missing, not thrown');
        equal(bare.winddir, undefined);
    });
});

describe('deciding a station has stopped reporting', () => {
    const at = minutesAgo => ({
        obsTimeUtc: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
    });

    it('counts a station between buckets as still reporting', () => {
        ok(isFresh(at(1)));
        ok(isFresh(at(19)), 'three missed buckets is a hiccup, not a stop');
    });

    it('counts twenty minutes of silence as stopped', () => {
        ok(!isFresh(at(21)));
        ok(!isFresh(at(180)));
    });

    it('falls on the stale side of exactly twenty minutes', () => {
        // Stated rather than left to chance, so the boundary cannot drift.
        const now = Date.now();
        ok(!isFresh({obsTimeUtc: new Date(now - 20 * 60 * 1000).toISOString()}, now));
    });

    it('says no rather than throwing when there is nothing to judge', () => {
        ok(!isFresh(null));
        ok(!isFresh(undefined));
        ok(!isFresh({}));
        ok(!isFresh({obsTimeUtc: 'not a date at all'}));
    });

    it('reads the fixtures as the long-dead stations they are', () => {
        ok(!isFresh(observations.ILUMBY7), 'captured months ago');
    });
});

describe('reading a wind', () => {
    it('names the direction the wind comes from', () => {
        const wind = readings.wind(coopers);
        equal(wind.cardinal, 'WSW');
        equal(wind.bearing, 238);
        equal(wind.cardinalWords, 'west-southwest');
    });

    it('points the arrow the way the air is going', () => {
        // The reading names where the wind is *from*, so the arrow is turned
        //180 degrees away from it. Getting this backwards points every arrow
        // at the hill instead of away from it.
        equal(readings.wind(coopers).rotation, 238 + 180);
    });

    it('reads out direction and speed as one line', () => {
        equal(readings.wind(coopers).summary, 'WSW 7.1 km/h');
    });

    it('says so when it is gusting', () => {
        const wind = readings.wind(coopers);
        ok(wind.gusting);
        equal(wind.gust, '16.6');
        equal(wind.gustSummary, 'Gusting to 16.6 km/h');
    });

    it('does not announce a gust that is not one', () => {
        const steady = readings.wind({winddir: 90, uk_hybrid: {windSpeed: 10, windGust: 10}});
        ok(!steady.gusting);
        equal(steady.gustSummary, 'Wind');
    });

    it('holds its shape when the station is dark', () => {
        const nothing = readings.wind(null);
        equal(nothing.cardinal, readings.NO_READING);
        equal(nothing.speed, readings.NO_READING);
        equal(nothing.bearing, null);
        equal(nothing.cardinalWords, null);
        // Zero rather than null: the arrow still has to be given an angle.
        equal(nothing.rotation, 0);
        ok(!nothing.gusting);
    });

    it('handles a station that reports speed but no direction', () => {
        const wind = readings.wind({uk_hybrid: {windSpeed: 4, windGust: 9}});
        equal(wind.cardinal, readings.NO_READING);
        equal(wind.speed, '4.0');
        ok(wind.gusting, 'a gust is still a gust without a bearing');
    });
});

describe('the other readings', () => {
    it('reads temperature to a tenth', () => {
        equal(readings.temperature(coopers).celsius, '23.7');
        equal(readings.temperature(coopers).summary, '23.7 ºC');
    });

    it('reads rainfall to a hundredth, because the day starts at nothing', () => {
        equal(readings.rainfall(park).millimetres, '0.30');
        equal(readings.rainfall(coopers).millimetres, '0.00');
    });

    it('reads the rain rate', () => {
        equal(readings.precipitationRate(coopers).summary, '0.00 mm/hr');
    });

    it('stands in for anything the station does not report', () => {
        equal(readings.temperature(null).celsius, readings.NO_READING);
        equal(readings.rainfall({}).millimetres, readings.NO_READING);
    });
});

describe('interpreting an observation', () => {
    it('puts each reading in words', () => {
        const metrics = weather.describeObservation(coopers);
        equal(metrics.humidity.percent, '35');
        equal(metrics.humidity.description, 'Comfortable humidity, pleasant conditions');
        equal(metrics.dewPoint.description, 'Dry and comfortable');
        equal(metrics.heatIndex.description, 'Comfortable, minimal heat stress');
        equal(metrics.windChill.description, 'Minimal wind chill risk');
        equal(metrics.uvIndex.risk, 'Moderate');
    });

    it('leaves out a sensor the station does not carry, and keeps the rest', () => {
        // This is the case that used to matter most: one missing reading must
        // not take the other five with it.
        const metrics = weather.describeObservation(coopers);
        equal(metrics.barometricPressure, null, 'no pressure sensor here');
        ok(metrics.humidity, 'humidity survives');
        ok(metrics.dewPoint, 'dew point survives');
    });

    it('corrects pressure to sea level before naming it', () => {
        // 956.89 hPa at 1,624 ft is a normal day, not a storm. Reading the raw
        // number would call it "Very Low" every time.
        const metrics = weather.describeObservation(park, METRES.ILUMBY8);
        equal(metrics.barometricPressure.hPa, '956.9');
        equal(metrics.barometricPressure.kPa, '95.7');
        equal(metrics.barometricPressure.description, 'No big drama');
    });

    it('drops UV and sunlight for a station that reports neither', () => {
        equal(weather.describeObservation(silverStar).uvIndex, null);
        ok(weather.describeObservation(silverStar).humidity, 'humidity still read');
    });

    it('returns the same shape for a station that is dark', () => {
        equal(weather.describeObservation(undefined), {
            uvIndex: null,
            barometricPressure: null,
            dewPoint: null,
            humidity: null,
            heatIndex: null,
            windChill: null
        });
    });

    it('reads a genuine zero rather than discarding it', () => {
        const metrics = weather.describeObservation({humidity: 0, uv: 0, uk_hybrid: {}});
        equal(metrics.humidity.percent, '0');
        equal(metrics.uvIndex.risk, 'None');
    });
});

describe('sea level pressure', () => {
    it('leaves a station at sea level alone', () => {
        close(weather.computeSeaLevelPressure(0, 1013.25), 101.325, 1e-6);
    });

    it('corrects upwards with height', () => {
        const low = weather.computeSeaLevelPressure(300, 970);
        const high = weather.computeSeaLevelPressure(1500, 970);
        ok(high > low, 'the same reading higher up means more pressure at sea level');
    });
});

describe('lapse rate between two stations', () => {
    // A reading and the height it was taken at, because the reading does not
    // carry one.
    const at = (observation, feet) => ({observation, elevationFeet: feet});
    const coopersAt = at(coopers, METRES.ILUMBY7 / 0.3048);
    const silverStarAt = at(silverStar, METRES.IVERNO71 / 0.3048);

    it('works out which station is the higher one', () => {
        // Handed over either way round, the answer must not change sign.
        const down = weather.calculateLapseRate(silverStarAt, coopersAt);
        const up = weather.calculateLapseRate(coopersAt, silverStarAt);
        equal(down, up);
    });

    it('reports the rate, the height between them, and what it means', () => {
        const result = weather.calculateLapseRate(silverStarAt, coopersAt);
        equal(result.lapseRate, '-1.91');
        equal(result.elevDiff, '1987.2');
        equal(result.details.name, 'Conditional Instability');
        equal(result.details.description, 'Marginal thermal lift possible');
    });

    it('holds its shape when a station is missing', () => {
        equal(weather.calculateLapseRate(coopersAt, null),
            {lapseRate: null, elevDiff: null, details: null});
        equal(weather.calculateLapseRate(null, null),
            {lapseRate: null, elevDiff: null, details: null});
    });

    it('holds its shape when the site does not say how high a station is', () => {
        equal(weather.calculateLapseRate(coopersAt, at(silverStar, null)),
            {lapseRate: null, elevDiff: null, details: null});
    });

    it('does not divide by a height that is not there', () => {
        const same = at({uk_hybrid: {temp: 20}}, 1000);
        const other = at({uk_hybrid: {temp: 5}}, 1000);
        equal(weather.calculateLapseRate(same, other).lapseRate, '0.00');
    });
});

describe('lapse rate across the whole site', () => {
    const loaded = [
        entry('ILUMBY7', 'Coopers'),
        entry('ILUMBY8', 'FFP'),
        entry('IVERNO71', 'SilverStar')
    ];

    it('reads downhill, one segment per adjacent pair', () => {
        const segments = readings.lapseSegments(loaded);
        equal(segments.length, 2);
        equal(segments.map(s => s.span), ['SilverStar → Coopers', 'Coopers → FFP']);
    });

    it('carries the colour and the wording of each band', () => {
        const first = readings.lapseSegments(loaded)[0];
        close(first.rate, -1.91, 0.005);
        equal(first.elevDiff, 1987);
        ok(first.colour.startsWith('#'));
        ok(first.available);
    });

    it('pairs the survivors when a station in the middle drops out', () => {
        const segments = readings.lapseSegments(
            loaded.map(entry => entry.station.shortName === 'Coopers' ? {...entry, online: false} : entry));

        equal(segments.length, 1);
        equal(segments[0].span, 'SilverStar → FFP');
    });

    it('has nothing to report from one station', () => {
        equal(readings.lapseSegments([loaded[0]]), []);
        equal(readings.lapseSegments([]), []);
    });

    it('says so rather than throwing when a rate cannot be worked out', () => {
        const unavailable = readings.lapse(null);
        ok(!unavailable.available);
        equal(unavailable.summary, readings.NO_READING);
        equal(unavailable.title, 'Lapse Rate');
    });
});
