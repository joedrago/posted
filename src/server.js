import http from "node:http"
import { createReadStream } from "node:fs"
import { stat, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { listLibraries, listChildren, listMissing, listMissingSubs, findRoot } from "./tree.js"
import { inferQuery, pathSegments } from "./infer.js"
import { searchPosters } from "./search.js"
import { applyPoster, applySubtitle } from "./write.js"
import { searchSubtitles } from "./sources/opensubtitles.js"
import { computeMovieHash } from "./subs.js"
import { saveConfig } from "./config.js"

const UPLOAD_DIR = path.join(os.tmpdir(), "posted-uploads")
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const UPLOAD_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url))

const STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
}

const IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png"
}

// Start the web UI over the already-built library index. Binds to 0.0.0.0 so the
// UI is reachable from other hosts. Note: the apply endpoint writes files, so any
// host that can reach this port can trigger writes — only run on trusted networks.
export function startServer(index, opts = {}) {
    const port = opts.port ?? 8472
    const host = opts.host ?? "0.0.0.0"
    const cfg = {
        tmdbKey: opts.tmdbKey || null,
        fanartKey: opts.fanartKey || null,

        // OpenSubtitles: the api key gates search; user/pass gate downloads.
        // osAuth caches the bearer token resolved on the first download.
        osKey: opts.osKey || null,
        osUser: opts.osUser || null,
        osPass: opts.osPass || null,
        osAuth: null,

        uploads: new Map()
    }
    const server = http.createServer((req, res) => handle(index, cfg, req, res))

    return new Promise((resolve) => {
        server.listen(port, host, () => {
            const url = `http://${lanAddress()}:${port}`
            process.stderr.write(`posted: serving ${index.videos.length} videos at ${url}\n`)
            if (opts.open) openBrowser(url)
            resolve({ server, url })
        })
    })
}

// Pick the first non-internal IPv4 address so the printed URL is reachable from
// other hosts. Falls back to localhost when no LAN address is found.
function lanAddress() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family === "IPv4" && !addr.internal) return addr.address
        }
    }
    return "localhost"
}

async function handle(index, cfg, req, res) {
    try {
        const url = new URL(req.url, "http://localhost")

        if (url.pathname === "/api/config") {
            return sendJson(res, 200, {
                sources: { tmdb: Boolean(cfg.tmdbKey), fanart: Boolean(cfg.fanartKey) },
                subs: Boolean(index.subsEnabled),
                opensubtitles: { key: Boolean(cfg.osKey), login: Boolean(cfg.osUser && cfg.osPass) }
            })
        }

        if (url.pathname === "/api/settings") {
            if (req.method === "POST") return await saveSettings(cfg, req, res)
            return sendJson(res, 200, settingsState(cfg))
        }

        if (url.pathname === "/api/upload") return await upload(cfg, req, res)

        if (url.pathname === "/api/libraries") return sendJson(res, 200, listLibraries(index))

        if (url.pathname === "/api/tree") {
            const data = listChildren(index, url.searchParams.get("path") ?? "")
            if (!data) return sendJson(res, 404, { error: "path is not inside any library" })
            return sendJson(res, 200, data)
        }

        if (url.pathname === "/api/missing") return sendJson(res, 200, listMissing(index, url.searchParams.get("path")))

        if (url.pathname === "/api/subs/missing") {
            return sendJson(res, 200, listMissingSubs(index, url.searchParams.get("path")))
        }

        if (url.pathname === "/api/poster") return servePoster(index, url.searchParams.get("path"), res)

        // `await` matters: returning a rejected promise from inside this try would
        // escape the catch and crash the process as an unhandled rejection.
        if (url.pathname === "/api/search") return await search(index, cfg, url, res)

        if (url.pathname === "/api/apply") return await apply(index, cfg, req, res)

        if (url.pathname === "/api/subs/search") return await subsSearch(index, cfg, url, res)

        if (url.pathname === "/api/subs/apply") return await subsApply(index, cfg, req, res)

        if (url.pathname === "/api/play") return await play(index, req, res)

        return await serveStatic(url.pathname, res)
    } catch (err) {
        sendJson(res, 500, { error: err.message })
    }
}

// Resolve what to search for from the item's path, apply any UI overrides, and
// return candidate posters.
async function search(index, cfg, url, res) {
    if (!cfg.tmdbKey) return sendJson(res, 400, { error: "no poster source configured (set TMDB_API_KEY)" })

    const target = url.searchParams.get("path")
    const root = target && findRoot(index, target)
    if (!root) return sendJson(res, 404, { error: "path is not inside any library" })

    const isDir = url.searchParams.get("isDir") === "1"
    const query = inferQuery(target, isDir, root)

    const typeOverride = url.searchParams.get("type")
    const titleOverride = url.searchParams.get("title")
    const seasonOverride = url.searchParams.get("season")
    if (typeOverride === "movie" || typeOverride === "tv") query.type = typeOverride
    if (titleOverride) query.title = titleOverride
    if (seasonOverride !== null && seasonOverride !== "") query.season = Number(seasonOverride)
    if (query.type === "movie") query.season = null

    const { candidates } = await searchPosters(cfg, query)
    return sendJson(res, 200, { query, candidates, segments: pathSegments(target, isDir, root) })
}

async function apply(index, cfg, req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" })

    const body = JSON.parse((await readBody(req)) || "{}")
    const result = await applyPoster(index, cfg, body)
    return sendJson(res, result.needsConfirm ? 409 : 200, result)
}

// Resolve what subtitle to search for from the video's path (plus any UI
// overrides), compute its OpenSubtitles hash for exact-file matches, and return
// English candidates. `hash` tells the UI whether a file hash was available.
async function subsSearch(index, cfg, url, res) {
    if (!cfg.osKey) return sendJson(res, 400, { error: "no subtitle source configured (set an OpenSubtitles API key)" })

    const target = url.searchParams.get("path")
    const root = target && findRoot(index, target)
    if (!root) return sendJson(res, 404, { error: "path is not inside any library" })

    const resolved = path.resolve(target)
    if (!index.videos.some((v) => v.path === resolved)) return sendJson(res, 404, { error: "path is not a scanned video" })

    const query = inferQuery(resolved, false, root)
    const typeOverride = url.searchParams.get("type")
    const titleOverride = url.searchParams.get("title")
    const seasonOverride = url.searchParams.get("season")
    if (typeOverride === "movie" || typeOverride === "tv") query.type = typeOverride
    if (titleOverride) query.title = titleOverride
    if (seasonOverride !== null && seasonOverride !== "") query.season = Number(seasonOverride)

    const moviehash = await computeMovieHash(resolved)
    const { candidates } = await searchSubtitles(cfg, { ...query, moviehash })
    return sendJson(res, 200, { query, candidates, hash: Boolean(moviehash) })
}

async function subsApply(index, cfg, req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" })

    const body = JSON.parse((await readBody(req)) || "{}")
    const result = await applySubtitle(index, cfg, body)
    return sendJson(res, result.needsConfirm ? 409 : 200, result)
}

// Launch the chosen video in VLC so the user can eyeball subtitle sync. The path
// is validated against the scanned index (same gate as a write) before spawning.
async function play(index, req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" })

    const body = JSON.parse((await readBody(req)) || "{}")
    const target = body.path ? path.resolve(body.path) : null
    if (!target || findRoot(index, target) === null) return sendJson(res, 404, { error: "path is not inside any library" })
    if (!index.videos.some((v) => v.path === target)) return sendJson(res, 404, { error: "path is not a scanned video" })

    launchVlc(target)
    return sendJson(res, 200, { ok: true })
}

// Which secrets are configured, for the settings panel. Passwords are never sent
// back — only whether a full OpenSubtitles login (user + pass) is on file.
function settingsState(cfg) {
    return {
        tmdb: Boolean(cfg.tmdbKey),
        fanart: Boolean(cfg.fanartKey),
        osKey: Boolean(cfg.osKey),
        osLogin: Boolean(cfg.osUser && cfg.osPass)
    }
}

// Persist API keys to the config file and apply them to the running server.
function saveSettings(cfg, req, res) {
    return readBody(req).then((raw) => {
        const body = JSON.parse(raw || "{}")
        const partial = {}
        if (typeof body.tmdbKey === "string") partial.tmdbKey = body.tmdbKey.trim()
        if (typeof body.fanartKey === "string") partial.fanartKey = body.fanartKey.trim()
        if (typeof body.osKey === "string") partial.osKey = body.osKey.trim()
        if (typeof body.osUser === "string") partial.osUser = body.osUser.trim()
        if (typeof body.osPass === "string") partial.osPass = body.osPass.trim()
        saveConfig(partial)
        if ("tmdbKey" in partial) cfg.tmdbKey = partial.tmdbKey || null
        if ("fanartKey" in partial) cfg.fanartKey = partial.fanartKey || null
        if ("osKey" in partial) cfg.osKey = partial.osKey || null
        if ("osUser" in partial) cfg.osUser = partial.osUser || null
        if ("osPass" in partial) cfg.osPass = partial.osPass || null
        // Any credential change invalidates a cached bearer token.
        if ("osKey" in partial || "osUser" in partial || "osPass" in partial) cfg.osAuth = null
        return sendJson(res, 200, settingsState(cfg))
    })
}

// Accept a raw image body (sent with its content-type), store it in a temp file,
// and hand back a token. The actual write happens later via /api/apply with that
// token, so it goes through the same gates and overwrite confirmation.
async function upload(cfg, req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" })

    const type = (req.headers["content-type"] || "").split(";")[0].trim()
    const ext = UPLOAD_EXT[type]
    if (!ext) return sendJson(res, 400, { error: `unsupported image type: ${type || "unknown"}` })

    const buf = await readRawBody(req, MAX_UPLOAD_BYTES)
    await mkdir(UPLOAD_DIR, { recursive: true })
    const id = randomUUID()
    const tempPath = path.join(UPLOAD_DIR, id + ext)
    await writeFile(tempPath, buf)
    cfg.uploads.set(id, tempPath)

    return sendJson(res, 200, { uploadId: id })
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = ""
        req.on("data", (chunk) => {
            data += chunk
            if (data.length > 1_000_000) reject(new Error("request body too large"))
        })
        req.on("end", () => resolve(data))
        req.on("error", reject)
    })
}

function readRawBody(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let total = 0
        req.on("data", (chunk) => {
            total += chunk.length
            if (total > max) {
                reject(new Error("upload too large"))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on("end", () => resolve(Buffer.concat(chunks)))
        req.on("error", reject)
    })
}

// Only paths that were discovered as images during the scan are serveable, so a
// crafted ?path= can never escape the libraries.
function servePoster(index, p, res) {
    if (!p || !index.images.has(path.resolve(p).toLowerCase())) {
        return sendJson(res, 404, { error: "no such poster" })
    }
    const actual = index.images.get(path.resolve(p).toLowerCase())
    const type = IMAGE_TYPES[path.extname(actual).toLowerCase()] ?? "application/octet-stream"
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" })
    createReadStream(actual).pipe(res)
}

async function serveStatic(pathname, res) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const full = path.join(PUBLIC_DIR, rel)

    // Keep static serving inside public/.
    if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" })

    try {
        const info = await stat(full)
        if (!info.isFile()) return sendJson(res, 404, { error: "not found" })
    } catch {
        return sendJson(res, 404, { error: "not found" })
    }

    const type = STATIC_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream"
    res.writeHead(200, { "content-type": type })
    createReadStream(full).pipe(res)
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(payload)
}

function openBrowser(url) {
    import("node:child_process").then(({ spawn }) => {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
        spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref()
    })
}

// Open a file in VLC, detached so it outlives the request. On macOS we go through
// `open -a VLC` (VLC is rarely on PATH there); elsewhere we invoke `vlc` directly.
function launchVlc(file) {
    import("node:child_process").then(({ spawn }) => {
        const cmd = process.platform === "darwin" ? "open" : "vlc"
        const args = process.platform === "darwin" ? ["-a", "VLC", file] : [file]
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref()
    })
}
