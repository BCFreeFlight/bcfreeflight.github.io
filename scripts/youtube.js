/**
 * YouTube embedding and live status.
 *
 * Status comes from the IFrame Player API rather than the Data API: it needs no
 * key and has no quota, where a Data API `search.list` costs 100 units against a
 * 10,000/day allowance shared by every visitor to the site.
 */

const IFRAME_API = 'https://www.youtube.com/iframe_api';

// The probe reports within about half a second; this is only a backstop.
const PROBE_TIMEOUT_MS = 12000;

export class YouTube {
    constructor() {
        this.apiReady = null;
    }

    /**
     * Loads the IFrame Player API once, shared by every caller.
     * @returns {Promise<Object>} The global YT namespace
     */
    loadApi() {
        if (!this.apiReady) {
            this.apiReady = new Promise((resolve, reject) => {
                if (window.YT?.Player) {
                    resolve(window.YT);
                    return;
                }

                const previous = window.onYouTubeIframeAPIReady;
                window.onYouTubeIframeAPIReady = () => {
                    if (typeof previous === 'function') previous();
                    resolve(window.YT);
                };

                const script = document.createElement('script');
                script.src = IFRAME_API;
                script.onerror = () => {
                    this.apiReady = null;
                    reject(new Error('Could not load the YouTube IFrame API'));
                };
                document.head.appendChild(script);
            });
        }

        return this.apiReady;
    }

    /**
     * The embed URL for a configured YouTube source.
     *
     * A channel is preferred over a video id: `live_stream?channel=` always
     * resolves to whatever that channel is broadcasting now, where a video id is
     * one particular broadcast and goes stale the next time the stream restarts.
     *
     * @param {Object} youtube - Normalised {channel, video} from the site configuration
     * @param {Object} [params={}] - Extra query parameters for the player
     * @returns {?string} The embed URL, or null when nothing is configured
     */
    embedUrl(youtube, params = {}) {
        if (!youtube?.channel && !youtube?.video) return null;

        const url = youtube.channel
            ? new URL('https://www.youtube.com/embed/live_stream')
            : new URL(`https://www.youtube.com/embed/${youtube.video}`);

        if (youtube.channel) url.searchParams.set('channel', youtube.channel);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

        return url.toString();
    }

    /**
     * Whether the configured source is broadcasting right now.
     *
     * The player has to be started for this to be true: with autoplay off it
     * reports a cued video and `isLive` reads false even mid-broadcast, which
     * would be a false negative. So the probe autoplays muted in a hidden frame
     * and is torn down as soon as it answers, which takes about half a second.
     *
     * @param {Object} youtube - Normalised {channel, video} from the site configuration
     * @returns {Promise<?boolean>} True when live, false when not, null when undetermined
     */
    async isLive(youtube) {
        const src = this.embedUrl(youtube, {
            enablejsapi: 1,
            autoplay: 1,
            mute: 1,
            controls: 0,
            playsinline: 1,
            origin: window.location.origin
        });

        if (!src) return null;

        const YT = await this.loadApi();

        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText =
            'position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';

        const frame = document.createElement('iframe');
        frame.src = src;
        frame.width = 1;
        frame.height = 1;
        frame.allow = 'autoplay';
        frame.title = 'Live stream status probe';
        host.appendChild(frame);
        document.body.appendChild(host);

        return new Promise(resolve => {
            let settled = false;
            let player;

            const finish = result => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    player?.destroy();
                } catch (error) {
                    // A player torn down mid-handshake is not worth reporting.
                }
                host.remove();
                resolve(result);
            };

            const read = state => {
                const data = player?.getVideoData?.();
                if (data?.isLive) {
                    finish(true);
                    return;
                }

                // Playing but not live means a past broadcast is being served,
                // which is the channel sitting idle. No need to wait out the timeout.
                if (state === YT.PlayerState.PLAYING) finish(false);
            };

            const timer = setTimeout(() => {
                // Nothing ever claimed to be live, so treat it as off air.
                finish(false);
            }, PROBE_TIMEOUT_MS);

            player = new YT.Player(frame, {
                events: {
                    onReady: () => read(),
                    onStateChange: event => read(event.data),
                    // 100 is "no such video", which is what an idle channel gives.
                    onError: () => finish(false)
                }
            });
        });
    }
}

const youtube = new YouTube();
export default youtube;
