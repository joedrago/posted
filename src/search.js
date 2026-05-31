import { searchPosters as tmdbSearch, externalIds } from "./sources/tmdb.js"
import { fanartPosters } from "./sources/fanart.js"

// Aggregate candidate posters across every configured source. TMDB drives the
// title match; fanart.tv chains off that match's external ids. A fanart failure
// is swallowed so it can never take down the (primary) TMDB results.
export async function searchPosters(cfg, query) {
    if (!query.title) return { candidates: [] }

    const candidates = []
    let match = null

    if (cfg.tmdbKey) {
        const tmdb = await tmdbSearch(cfg, query)
        candidates.push(...tmdb.candidates)
        match = tmdb.match
    }

    if (cfg.fanartKey && match && cfg.tmdbKey) {
        try {
            let ext = null
            try {
                ext = await externalIds(cfg, match.type, match.id)
            } catch {
                ext = null
            }
            candidates.push(...(await fanartPosters(cfg, query, match, ext)))
        } catch {
            // fanart.tv is best-effort; keep the TMDB candidates.
        }
    }

    return { candidates }
}
