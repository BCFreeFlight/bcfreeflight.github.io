import {describe, it, equal, ok, close, fixture} from './runner.js';
import weather from '../scripts/weather.js';
import * as readings from '../scripts/readings.js';

/**
 * The readings, and what the site says they mean.
 *
 * Everything here runs against captured responses from the three real stations,
 * which between them cover the cases that matter: one reports no pressure, one
 * reports no UV or sunlight, and they sit at three different heights.
 */

const observations = {};

for (const id of ['ILUMBY7', 'ILUMBY8', 'IVERNO71']) {
    observations[id] = (await fixture(`current-${id}`)).observations[0];
}

const coopers = observations.ILUMBY7;   // 3,466 ft — no pressure sensor
const park = observations.ILUMBY8;      // 1,624 ft — the valley floor
const silverStar = observations.IVERNO71; // 5,453 ft — no UV or solar sensor

describe('reading a wind', () => {
    it('names the direction the wind comes from', () => {
        const wind = readings.wind(coopers);
        equal(wind.cardinal, 'WSW');
        equal(wind.bearing, 244);
        equal(wind.cardinalWords, 'west-southwest');
    });

    it('points the arrow the way the air is going', () => {
        // The reading names where the wind is *from*, so the arrow is turned
        //180 degrees away from it. Getting this backwards points every arrow
        // at the hill instead of away from it.
        equal(readings.wind(coopers).rotation, 244 + 180);
    });

    it('reads out direction and speed as one line', () => {
        equal(readings.wind(coopers).summary, 'WSW 15.8 km/h');
    });

    it('says so when it is gusting', () => {
        const wind = readings.wind(coopers);
        ok(wind.gusting);
        equal(wind.gust, '20.2');
        equal(wind.gustSummary, 'Gusting to 20.2 km/h');
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
        equal(readings.temperature(coopers).celsius, '23.9');
        equal(readings.temperature(coopers).summary, '23.9 ºC');
    });

    it('reads rainfall to a hundredth, because the day starts at nothing', () => {
        equal(readings.rainfall(park).millimetres, '0.01');
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
        const metrics = weather.describeObservation(park);
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
        const low = weather.computeSeaLevelPressure(1000, 970);
        const high = weather.computeSeaLevelPressure(5000, 970);
        ok(high > low, 'the same reading higher up means more pressure at sea level');
    });
});

describe('lapse rate between two stations', () => {
    it('works out which station is the higher one', () => {
        // Handed over either way round, the answer must not change sign.
        const down = weather.calculateLapseRate(silverStar, coopers);
        const up = weather.calculateLapseRate(coopers, silverStar);
        equal(down, up);
    });

    it('reports the rate, the height between them, and what it means', () => {
        const result = weather.calculateLapseRate(silverStar, coopers);
        equal(result.lapseRate, '-1.66');
        equal(result.elevDiff, '1987.0');
        equal(result.details.name, 'Conditional Instability');
        equal(result.details.description, 'Marginal thermal lift possible');
    });

    it('holds its shape when a station is missing', () => {
        equal(weather.calculateLapseRate(coopers, null),
            {lapseRate: null, elevDiff: null, details: null});
        equal(weather.calculateLapseRate(null, null),
            {lapseRate: null, elevDiff: null, details: null});
    });

    it('does not divide by a height that is not there', () => {
        const same = {uk_hybrid: {elev: 1000, temp: 20}};
        const other = {uk_hybrid: {elev: 1000, temp: 5}};
        equal(weather.calculateLapseRate(same, other).lapseRate, '0.00');
    });
});

describe('lapse rate across the whole site', () => {
    const loaded = [
        {station: {shortName: 'Coopers'}, observation: coopers, online: true},
        {station: {shortName: 'FFP'}, observation: park, online: true},
        {station: {shortName: 'SilverStar'}, observation: silverStar, online: true}
    ];

    it('reads downhill, one segment per adjacent pair', () => {
        const segments = readings.lapseSegments(loaded);
        equal(segments.length, 2);
        equal(segments.map(s => s.span), ['SilverStar → Coopers', 'Coopers → FFP']);
    });

    it('carries the colour and the wording of each band', () => {
        const first = readings.lapseSegments(loaded)[0];
        close(first.rate, -1.66, 0.005);
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
