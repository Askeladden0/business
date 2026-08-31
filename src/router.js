import { HttpError } from './http.js';

/**
 * Liten ruter. Støtter faste stier og ett nivå med :parameter. Bevisst holdt
 * uten rammeverk, fordi hele produktet har under tjue ruter og et rammeverk
 * ville vært den mest sannsynlige kilden til fremtidig vedlikehold.
 */
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    routes.push({ method, pattern, segments, handler });
  }

  const router = {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    routes,

    match(method, pathname) {
      const parts = pathname.split('/').filter(Boolean);
      let pathMatched = false;
      for (const route of routes) {
        if (route.segments.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < parts.length; i += 1) {
          const segment = route.segments[i];
          if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
          else if (segment !== parts[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        pathMatched = true;
        // HEAD behandles som GET; kroppen droppes i send().
        const wanted = method === 'HEAD' ? 'GET' : method;
        if (route.method === wanted) return { handler: route.handler, params };
      }
      if (pathMatched) throw new HttpError(405, 'Metoden er ikke støttet for denne stien');
      return null;
    },
  };
  return router;
}
