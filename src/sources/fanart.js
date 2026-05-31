// fanart.tv poster source. Keyed by external ids resolved from the TMDB match:
// movies by IMDb (or TMDB) id, TV by TheTVDB id. Season posters are tagged with
// a season number so we can filter to the requested season.

const API = "https://webservice.fanart.tv/v3"

async function fanartGet(cfg, pathname) {
    const url = `${API}${pathname}?api_key=${encodeURIComponent(cfg.fanartKey)}`
    const res = await fetch(url, { headers: { accept: "application/json" } })
    if (res.status === 404) return null // no fanart entry for this title — not an error
    if (!res.ok) throw new Error(`fanart.tv ${res.status}`)
    return res.json()
}

// fanart asset URLs look like https://assets.fanart.tv/fanart/<file>; the small
// preview lives at https://assets.fanart.tv/preview/<file>.
function previewOf(url) {
    return url.replace("assets.fanart.tv/fanart/", "assets.fanart.tv/preview/")
}

function candidateFrom(poster, label) {
    return {
        source: "fanart",
        key: `fanart:${poster.id || poster.url}`,
        url: poster.url,
        thumb: previewOf(poster.url),
        label,
        width: null, // fanart.tv doesn't report dimensions
        height: null,
        lang: poster.lang || null
    }
}

// Candidate posters from fanart.tv for an already-resolved TMDB match.
// `ext` is { imdb_id, tvdb_id } from tmdb externalIds (may be null).
export async function fanartPosters(cfg, query, match, ext) {
    if (!cfg.fanartKey || !match) return []
    const candidates = []

    if (query.type === "movie") {
        const id = ext?.imdb_id || match.id // fanart accepts an IMDb id or a TMDB id
        const data = await fanartGet(cfg, `/movies/${id}`)
        const label = match.year ? `${match.title} (${match.year})` : match.title
        for (const p of data?.movieposter || []) candidates.push(candidateFrom(p, label))
        return candidates
    }

    // TV requires a TheTVDB id, which only comes from external ids.
    const tvdb = ext?.tvdb_id
    if (!tvdb) return candidates
    const data = await fanartGet(cfg, `/tv/${tvdb}`)
    if (!data) return candidates

    for (const p of data.tvposter || []) {
        candidates.push(candidateFrom(p, match.title))
    }
    for (const p of data.seasonposter || []) {
        if (query.season == null || String(p.season) === String(query.season)) {
            candidates.push(candidateFrom(p, `${match.title} · Season ${p.season}`))
        }
    }
    return candidates
}
