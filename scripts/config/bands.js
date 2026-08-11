/**
 * What the numbers mean.
 *
 * Every reading on the site is shown beside a plain-language reading of it,
 * because a pilot deciding whether to fly is asking "is this good?" rather than
 * "what is the number?". Those judgements are all the same shape — an ordered
 * list of ranges, each with the words for it — so they are gathered here as
 * data, apart from the code that looks them up.
 *
 * Tables are read in order and the first entry that accepts the value wins, so
 * they must stay sorted. Most are written as ascending ceilings (`max`); wind
 * chill runs the other way and is written as descending floors (`min`).
 * `lib/numbers.js#band` understands both.
 */

/**
 * Air stability, in ºC per 1000 ft. Negative is cooling with height, which is
 * what makes thermals; positive is an inversion, which caps them.
 * @type {Object[]}
 */
export const LAPSE = [
    {name: 'Unstable', max: -3.0, color: '#ff0000', description: 'Strong thermals, turbulent conditions possible'},
    {name: 'Conditional Instability', max: -2.5, color: '#ff8000', description: 'Thermals likely, some instability'},
    {name: 'Conditional Instability', max: -2.0, color: '#ffb6ff', description: 'Weaker thermals developing'},
    {name: 'Conditional Instability', max: -1.5, color: '#dcb7ff', description: 'Marginal thermal lift possible'},
    {name: 'Stable', max: -1.2, color: '#fddbb0', description: 'Mostly smooth air, limited thermal activity'},
    {name: 'Stable', max: -0.5, color: '#8080ff', description: 'Very little thermal activity, smooth flying'},
    {name: 'Stable', max: 0.0, color: '#c0cfff', description: 'Cool and calm, no climb potential'},
    {name: 'Inverted', max: 0.5, color: '#d3d3d3', description: 'Temperature increases with height, suppresses lift'},
    {name: 'Strong Inversion', max: Infinity, color: '#808080', description: 'No lift, capped inversion layer'}
];

/** @type {Object[]} UV index. */
export const UV = [
    {risk: 'None', max: 0, description: 'No risk: no UV exposure'},
    {risk: 'Low', max: 2.9, description: 'Minimal risk: light SPF, sunglasses'},
    {risk: 'Moderate', max: 5.9, description: 'Moderate risk: SPF 30+, hat'},
    {risk: 'High', max: 7.9, description: 'High risk: SPF 30–50, cover up'},
    {risk: 'Very High', max: 10.9, description: 'Very high risk: SPF 50+, cover up'},
    {risk: 'Extreme', max: Infinity, description: 'Extreme risk: Stay indoors'}
];

/**
 * US Air Quality Index. The EPA's own categories and their colours, which are
 * the ones every air quality map is drawn in, so the wording here matches what
 * a pilot has already seen elsewhere that day.
 *
 * The advice is written for flying rather than for staying indoors: launching
 * means hiking up with a wing on your back and then sitting in the air for
 * hours, which is a long time breathing hard in whatever the valley is holding.
 *
 * @type {Object[]}
 */
export const AIR_QUALITY = [
    {name: 'Good', max: 50, color: '#00e400', description: 'Clear air, nothing to plan around'},
    {name: 'Moderate', max: 100, color: '#ffff00', description: 'Fine for most, noticeable on a long climb out'},
    {name: 'Unhealthy for Sensitive Groups', max: 150, color: '#ff7e00', description: 'Asthma and sensitive lungs should sit this one out'},
    {name: 'Unhealthy', max: 200, color: '#ff0000', description: 'Everyone feels this one, so keep flights short'},
    {name: 'Very Unhealthy', max: 300, color: '#8f3f97', description: 'Smoke thick enough to cut visibility and lift alike'},
    {name: 'Hazardous', max: Infinity, color: '#7e0023', description: 'Not a flying day'}
];

/** @type {Object[]} Sea-level equivalent pressure, in kPa. */
export const PRESSURE = [
    {name: 'Very Low', max: 98, description: 'Storms, maybe even severe weather'},
    {name: 'Low', max: 100, description: 'Clouds, wind, likely rain'},
    {name: 'Normal', max: 102, description: 'No big drama'},
    {name: 'High', max: Infinity, description: 'Clear skies, stable weather'}
];

/** @type {Object[]} Dew point, in ºC. */
export const DEW_POINT = [
    {description: 'Dry and comfortable', max: 10},
    {description: 'Slightly humid yet still pleasant', max: 16},
    {description: 'Noticeably muggy, sweat lingers', max: 18},
    {description: 'Very uncomfortable, heavy oppressive humidity', max: 21},
    {description: 'Oppressively humid, extremely sticky conditions', max: Infinity}
];

/** @type {Object[]} Relative humidity, as a percentage. */
export const HUMIDITY = [
    {description: 'Dry air, potential dehydration risk', max: 30},
    {description: 'Comfortable humidity, pleasant conditions', max: 50},
    {description: 'Slight humidity, mild stickiness', max: 60},
    {description: 'Humid air, noticeable discomfort', max: 75},
    {description: 'Very humid, oppressive moisture', max: Infinity}
];

/** @type {Object[]} Heat index, in ºC. */
export const HEAT_INDEX = [
    {description: 'Comfortable, minimal heat stress', max: 27},
    {description: 'Caution: some discomfort, stay hydrated', max: 32},
    {description: 'Extreme caution: heat cramps possible', max: 39},
    {description: 'Danger: heatstroke likely, extreme caution', max: 46},
    {description: 'Extreme danger: heat stroke imminent', max: Infinity}
];

/**
 * Wind chill, in ºC. Written as floors and read downwards, because the risk
 * rises as the number falls.
 * @type {Object[]}
 */
export const WIND_CHILL = [
    {description: 'Minimal wind chill risk', min: 0},
    {description: 'Mild cold—light jacket', min: -10},
    {description: 'High frostbite risk—dress warm', min: -28},
    {description: 'Severe frostbite risk—limit exposure', min: -40},
    {description: 'Extreme risk—avoid outdoor exposure', min: Number.NEGATIVE_INFINITY}
];
