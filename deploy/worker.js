/*
 * The only dynamic code on the site, and it exists for one reason.
 *
 * wrangler.jsonc sets html_handling:"none" so that URLs keep their ".html" --
 * seventeen served files read the filename out of location.pathname to decide
 * which board they are on, and Cloudflare's default would strip it. See the
 * comment in wrangler.jsonc.
 *
 * "none" also switches off the directory-index lookup, and that matters more
 * than it sounds: "/driver/" is the URL DRIVERS ARE TEXTED. Without this
 * shim it would 404 and paperwork submissions would simply stop, looking
 * from our side like drivers who did not bother.
 *
 * So: exact asset hits never reach this code at all -- /loadboard.js and
 * /houston.html are served directly by Cloudflare, with their ETags intact
 * (site-version-watch.js depends on that ETag). This runs ONLY on a miss,
 * and does one thing: map a directory-shaped path to its index.html.
 */
const INDEX = 'index.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Only ever rewrite directory-shaped paths. Anything else is a real 404.
    let candidate = null;
    if (path.endsWith('/')) {
      candidate = path + INDEX;
    } else if (!path.split('/').pop().includes('.')) {
      // "/driver" typed without the trailing slash.
      candidate = path + '/' + INDEX;
    }
    if (!candidate) return new Response('Not found', { status: 404 });

    const rewritten = new URL(url);
    rewritten.pathname = candidate;
    const res = await env.ASSETS.fetch(new Request(rewritten, request));
    if (res.status === 404) return new Response('Not found', { status: 404 });
    return res;
  },
};
