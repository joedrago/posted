import http from "node:http"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { listLibraries, listChildren, listMissing } from "./tree.js"

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

// Start the web UI over the already-built library index. Read-only for now:
// it serves the gallery and its data, but writes nothing.
export function startServer(index, opts = {}) {
    const port = opts.port ?? 8472
    const server = http.createServer((req, res) => handle(index, req, res))

    return new Promise((resolve) => {
        server.listen(port, () => {
            const url = `http://localhost:${port}`
            process.stderr.write(`posted: serving ${index.videos.length} videos at ${url}\n`)
            if (opts.open) openBrowser(url)
            resolve({ server, url })
        })
    })
}

async function handle(index, req, res) {
    try {
        const url = new URL(req.url, "http://localhost")

        if (url.pathname === "/api/libraries") return sendJson(res, 200, listLibraries(index))

        if (url.pathname === "/api/tree") {
            const data = listChildren(index, url.searchParams.get("path") ?? "")
            if (!data) return sendJson(res, 404, { error: "path is not inside any library" })
            return sendJson(res, 200, data)
        }

        if (url.pathname === "/api/missing") return sendJson(res, 200, listMissing(index))

        if (url.pathname === "/api/poster") return servePoster(index, url.searchParams.get("path"), res)

        return serveStatic(url.pathname, res)
    } catch (err) {
        sendJson(res, 500, { error: err.message })
    }
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
