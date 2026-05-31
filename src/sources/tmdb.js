// TMDB poster source. Supports both auth styles: a v4 bearer token (starts with
// "ey", sent as Authorization) or a classic v3 key (sent as ?api_key=).

const API = "https://api.themoviedb.org/3"
const IMG = "https://image.tmdb.org/t/p"

// w780 keeps a 2:3 poster at 780x1170 — under the 1200px-tall cap, so the common
// path needs no resizing. w342 is the picker thumbnail.
const FULL_SIZE = "w780"
const THUMB_SIZE = "w342"

async function tmdbGet(cfg, pathname, params = {}) {
    const url = new URL(API + pathname)
    for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") url.searchParams.set(k, v)
    }

    const headers = { accept: "application/json" }
    if (cfg.tmdbKey.startsWith("ey")) headers.authorization = `Bearer ${cfg.tmdbKey}`
    else url.searchParams.set("api_key", cfg.tmdbKey)

    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`TMDB ${res.status} on ${pathname}`)
    return res.json()
}

function yearOf(result) {
    const date = result.release_date || result.first_air_date || ""
    return date.slice(0, 4) || null
}

async function search(cfg, type, title, year) {
    const endpoint = type === "tv" ? "/search/tv" : "/search/movie"
    const yearParam = type === "tv" ? { first_air_date_year: year } : { year }
    const data = await tmdbGet(cfg, endpoint, { query: title, ...yearParam })
    return (data.results || []).map((r) => ({
        id: r.id,
        title: r.title || r.name,
        year: yearOf(r),
        poster_path: r.poster_path
    }))
}

// All poster images for a title. For a TV season we prefer season-specific
// posters, falling back to the show's posters when the season has none.
async function posterImages(cfg, type, id, season) {
    const params = { include_image_language: "en,null" }
    if (type === "tv" && season != null) {
        const data = await tmdbGet(cfg, `/tv/${id}/season/${season}/images`, params)
        if (data.posters && data.posters.length) return data.posters
    }
    const endpoint = type === "tv" ? `/tv/${id}/images` : `/movie/${id}/images`
    const data = await tmdbGet(cfg, endpoint, params)
    return data.posters || []
}

function candidateFrom(filePath, label, meta = {}) {
    return {
        source: "tmdb",
        key: filePath,
        url: `${IMG}/${FULL_SIZE}${filePath}`,
        thumb: `${IMG}/${THUMB_SIZE}${filePath}`,
        label,
        width: meta.width ?? null,
        height: meta.height ?? null,
        lang: meta.iso_639_1 ?? null
    }
}

// Search TMDB and return a deduped list of candidate posters: every poster for
// the best-matching title, plus the primary poster of the next few matches so a
// wrong top hit is still recoverable.
export async function searchPosters(cfg, { type, title, year, season }) {
    if (!cfg.tmdbKey) throw new Error("TMDB API key not configured")
    if (!title) return { candidates: [] }

    const results = await search(cfg, type, title, year)
    const candidates = []
    const seen = new Set()

    const add = (filePath, label, meta) => {
        if (!filePath || seen.has(filePath)) return
        seen.add(filePath)
        candidates.push(candidateFrom(filePath, label, meta))
    }

    const top = results.slice(0, 4)
    for (let i = 0; i < top.length; i++) {
        const r = top[i]
        const label = r.year ? `${r.title} (${r.year})` : r.title
        if (i === 0) {
            const posters = await posterImages(cfg, type, r.id, season)
            for (const p of posters) add(p.file_path, label, p)
        }
        add(r.poster_path, label, {})
    }

    // `match` is the best hit; fanart.tv lookups chain off its id/external ids.
    const match = top.length ? { id: top[0].id, type, title: top[0].title, year: top[0].year } : null
    return { candidates, match }
}

// IMDb / TheTVDB ids for a TMDB title — fanart.tv keys movies by IMDb/TMDB id
// and TV by TheTVDB id, so this bridges a TMDB match to a fanart.tv lookup.
export async function externalIds(cfg, type, id) {
    const data = await tmdbGet(cfg, `/${type}/${id}/external_ids`)
    return { imdb_id: data.imdb_id || null, tvdb_id: data.tvdb_id || null }
}
