import http from "node:http"
import { createReadStream } from "node:fs"
import { stat, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { listLibraries, listChildren, listMissing, findRoot } from "./tree.js"
import { inferQuery } from "./infer.js"
import { searchPosters } from "./search.js"
import { applyPoster } from "./write.js"
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

// Start the web UI over the already-built library index. Bound to loopback only:
// the apply endpoint writes files, so the server must not be reachable off-host.
export function startServer(index, opts = {}) {
    const port = opts.port ?? 8472
    const cfg = { tmdbKey: opts.tmdbKey || null, fanartKey: opts.fanartKey || null, uploads: new Map() }
    const server = http.createServer((req, res) => handle(index, cfg, req, res))

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
            const url = `http://localhost:${port}`
            process.stderr.write(`posted: serving ${index.videos.length} videos at ${url}\n`)
            if (opts.open) openBrowser(url)
            resolve({ server, url })
        })
    })
}

async function handle(index, cfg, req, res) {
    try {
        const url = new URL(req.url, "http://localhost")

        if (url.pathname === "/api/config") {
            return sendJson(res, 200, { sources: { tmdb: Boolean(cfg.tmdbKey), fanart: Boolean(cfg.fanartKey) } })
        }

        if (url.pathname === "/api/settings") {
            if (req.method === "POST") return await saveSettings(cfg, req, res)
            return sendJson(res, 200, { tmdb: Boolean(cfg.tmdbKey), fanart: Boolean(cfg.fanartKey) })
        }

        if (url.pathname === "/api/upload") return await upload(cfg, req, res)

        if (url.pathname === "/api/libraries") return sendJson(res, 200, listLibraries(index))

        if (url.pathname === "/api/tree") {
            const data = listChildren(index, url.searchParams.get("path") ?? "")
            if (!data) return sendJson(res, 404, { error: "path is not inside any library" })
            return sendJson(res, 200, data)
        }

        if (url.pathname === "/api/missing") return sendJson(res, 200, listMissing(index))

        if (url.pathname === "/api/poster") return servePoster(index, url.searchParams.get("path"), res)

        // `await` matters: returning a rejected promise from inside this try would
        // escape the catch and crash the process as an unhandled rejection.
        if (url.pathname === "/api/search") return await search(index, cfg, url, res)

        if (url.pathname === "/api/apply") return await apply(index, cfg, req, res)

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
    return sendJson(res, 200, { query, candidates })
}

async function apply(index, cfg, req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" })

    const body = JSON.parse((await readBody(req)) || "{}")
    const result = await applyPoster(index, cfg, body)
    return sendJson(res, result.needsConfirm ? 409 : 200, result)
}

// Persist API keys to the config file and apply them to the running server.
function saveSettings(cfg, req, res) {
    return readBody(req).then((raw) => {
        const body = JSON.parse(raw || "{}")
        const partial = {}
        if (typeof body.tmdbKey === "string") partial.tmdbKey = body.tmdbKey.trim()
        if (typeof body.fanartKey === "string") partial.fanartKey = body.fanartKey.trim()
        saveConfig(partial)
        if ("tmdbKey" in partial) cfg.tmdbKey = partial.tmdbKey || null
        if ("fanartKey" in partial) cfg.fanartKey = partial.fanartKey || null
        return sendJson(res, 200, { tmdb: Boolean(cfg.tmdbKey), fanart: Boolean(cfg.fanartKey) })
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
