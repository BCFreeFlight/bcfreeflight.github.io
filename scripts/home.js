import sites from './sites.js';

/**
 * The front page.
 *
 * Two cards per site — the readings and the camera — built from the same
 * sites.json every other page reads. The list used to be written into the
 * markup, which meant a new site appeared on its own page but never on the one
 * people arrive at.
 *
 * A site with no camera configured gets one card rather than a link to a stream
 * that does not exist.
 */

export class Home {
    /**
     * One site's cards.
     * @param {Object} site - A resolved site
     * @returns {string} HTML markup
     */
    renderSite(site) {
        const camera = sites.withCamera(site.stations);

        const cards = [
            {
                href: `/sites/${site.slug}`,
                icon: 'partly_cloudy_day',
                title: 'Weather',
                text: `Wind speed, direction, gusts, rainfall and lapse rate at ${site.name}.`
            },
            camera && {
                href: `/sites/${site.slug}/live`,
                icon: 'videocam',
                title: 'Live Feed',
                text: 'Full-screen video of the launch, with the readings over it.'
            }
        ].filter(Boolean);

        return `
            <section class="site">
                <h2 class="site-name">${site.name}</h2>
                <div class="cards">
                    ${cards.map(card => `
                        <a class="card" href="${card.href}">
                            <span class="card-icon material-symbols-outlined" aria-hidden="true">${card.icon}</span>
                            <h3 class="card-title">${card.title}</h3>
                            <p class="card-text">${card.text}</p>
                        </a>`).join('')}
                </div>
            </section>`;
    }

    /**
     * Draws every configured site, or says why it cannot.
     * @returns {Promise<void>}
     */
    async render() {
        const host = document.getElementById('sites');
        if (!host) return;

        try {
            const all = await sites.all();

            if (!all.length) {
                host.innerHTML = '<p class="empty">No sites are configured yet.</p>';
                return;
            }

            host.innerHTML = all.map(site => this.renderSite(site)).join('');
        } catch (error) {
            console.error('Could not read the site configuration:', error);
            // The links are the whole page, so a failure has to say so rather
            // than leave an empty column.
            host.innerHTML = '<p class="empty">The site list is unavailable right now.</p>';
        }
    }
}

const home = new Home();
export default home;
