// OpenSubtitles REST source (api.opensubtitles.com/api/v1). Searching needs only
// an Api-Key; downloading additionally needs an account login (username/password
// → a bearer token) and counts against the account's daily quota. We request
// English subtitles and lead with exact file-hash matches, which are the ones
// most likely to already be in sync.

const API = "https://api.opensubtitles.com/api/v1"
const USER_AGENT = "posted v0.1.0"

// Subtitles are tiny; this just stops a runaway/hostile link from filling memory.
const MAX_SUB_BYTES = 5 * 1024 * 1024

function headers(cfg, token) {
    const h = { "Api-Key": cfg.osKey, "User-Agent": USER_AGENT, Accept: "application/json" }
    if (token) h.Authorization = `Bearer ${token}`
    return h
}

async function osGet(cfg, pathname, params) {
    const url = new URL(API + pathname)
    for (const [k, v] of Object.entries(params || {})) {
        if (v != null && v !== "") url.searchParams.set(k, v)
    }
    const res = await fetch(url, { headers: headers(cfg) })
    if (!res.ok) throw new Error(`OpenSubtitles ${res.status} on ${pathname}`)
    return res.json()
}

// Search English subtitles for a title and/or an exact file hash. Hash matches
// (subtitles cut for this very file) are surfaced first, then the most-downloaded
// releases. `moviehash` alone is enough — a title is not required when we have it.
export async function searchSubtitles(cfg, { type, title, year, season, moviehash }) {
    if (!cfg.osKey) throw new Error("OpenSubtitles API key not configured")
    if (!title && !moviehash) return { candidates: [] }

    const params = { languages: "en" }
    if (title) params.query = title
    if (year) params.year = year
    if (moviehash) params.moviehash = moviehash
    if (type === "tv") {
        params.type = "episode"
        if (season != null) params.season_number = season
    } else {
        params.type = "movie"
    }

    const data = await osGet(cfg, "/subtitles", params)
    const candidates = []
    for (const item of data.data || []) {
        const a = item.attributes || {}
        const file = (a.files || [])[0]
        if (!file?.file_id) continue // can't be downloaded without a file id
        candidates.push({
            fileId: file.file_id,
            release: a.release || file.file_name || "subtitle",
            downloads: a.download_count || 0,
            rating: a.ratings || 0,
            hi: Boolean(a.hearing_impaired),
            fps: a.fps || null,
            hashMatch: Boolean(a.moviehash_match),
            lang: a.language || "en"
        })
    }

    candidates.sort((x, y) => Number(y.hashMatch) - Number(x.hashMatch) || y.downloads - x.downloads)
    return { candidates: candidates.slice(0, 30) }
}

// Resolve and cache a bearer token on `cfg`. The token is good for ~24h; we hold
// it in memory and re-login on demand if a download rejects it as stale.
async function loginRequest(cfg) {
    const res = await fetch(API + "/login", {
        method: "POST",
        headers: { ...headers(cfg), "Content-Type": "application/json" },
        body: JSON.stringify({ username: cfg.osUser, password: cfg.osPass })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.token) throw new Error(data.message || `OpenSubtitles login failed (${res.status})`)
    // base_url points VIP accounts at a faster host; honor it for downloads.
    return { token: data.token, baseUrl: data.base_url || null }
}

async function ensureLogin(cfg) {
    if (!cfg.osKey) throw new Error("OpenSubtitles API key not configured")
    if (cfg.osAuth?.token) return cfg.osAuth
    if (!cfg.osUser || !cfg.osPass) {
        throw new Error("OpenSubtitles login required to download — add a username and password in Settings")
    }
    cfg.osAuth = await loginRequest(cfg)
    return cfg.osAuth
}

function downloadRequest(cfg, auth, fileId) {
    const base = auth.baseUrl ? `https://${auth.baseUrl}/api/v1` : API
    return fetch(base + "/download", {
        method: "POST",
        headers: { ...headers(cfg, auth.token), "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: Number(fileId), sub_format: "srt" })
    })
}

// Turn a chosen file id into the actual subtitle bytes. Two steps: POST /download
// (auth'd) yields a temporary CDN link plus the remaining daily quota, then we
// GET that link. A stale token (401/406) triggers one re-login + retry.
export async function downloadSubtitle(cfg, fileId) {
    let auth = await ensureLogin(cfg)
    let res = await downloadRequest(cfg, auth, fileId)
    if (res.status === 401 || res.status === 406) {
        cfg.osAuth = null
        auth = await ensureLogin(cfg)
        res = await downloadRequest(cfg, auth, fileId)
    }

    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.link) throw new Error(data.message || `OpenSubtitles download failed (${res.status})`)

    const fileRes = await fetch(data.link)
    if (!fileRes.ok) throw new Error(`subtitle download failed: ${fileRes.status}`)
    const buffer = Buffer.from(await fileRes.arrayBuffer())
    if (buffer.length > MAX_SUB_BYTES) throw new Error(`subtitle exceeds ${MAX_SUB_BYTES} bytes`)

    return { buffer, fileName: data.file_name || null, remaining: data.remaining ?? null }
}
