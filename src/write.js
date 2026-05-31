import { writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { findRoot } from "./tree.js"

// Hard cap on a downloaded poster. w780 JPEGs are a few hundred KB; this just
// stops a malicious or runaway URL from writing an enormous file / exhausting
// memory. Generous headroom for legitimate high-res sources.
const MAX_POSTER_BYTES = 25 * 1024 * 1024

// Where a poster gets written for a target: beside a video as <stem>.jpg, or
// beside a directory as <dir>.jpg (the fallback sidecar). We always write .jpg.
export function destFor(targetPath, isDir) {
    if (isDir) return targetPath + ".jpg"
    const ext = path.extname(targetPath)
    return targetPath.slice(0, targetPath.length - ext.length) + ".jpg"
}

// Download a chosen poster and write it next to its target. Refuses to clobber an
// existing .jpg unless `overwrite` is set — the server surfaces needsConfirm so
// the UI can show its confirmation dialog. On success the in-memory index is
// updated so the gallery reflects the new poster without a rescan.
export async function applyPoster(index, cfg, { targetPath, isDir, imageUrl, uploadId, overwrite }) {
    const target = path.resolve(targetPath)

    // Gate 1: must be lexically inside a configured library root.
    if (findRoot(index, target) === null) throw new Error("target is not inside any library")
    // Gate 2: must be an item we actually scanned (a real video, directory, or
    // library root). This rejects arbitrary in-root subpaths and — because the
    // scan never descends into symlinks — also prevents writing through a
    // symlinked directory to somewhere outside the library.
    if (!isKnownTarget(index, target, isDir)) throw new Error("target is not a scanned video or directory")

    const dest = destFor(target, isDir)
    // Gate 3: never clobber an existing .jpg without explicit confirmation.
    if (existsSync(dest) && !overwrite) return { needsConfirm: true, existing: dest }

    // Source the bytes from either a local upload (server-held token) or an https
    // download. A client never supplies a source *path* — only a token or url.
    const buf = uploadId ? await readUpload(cfg, uploadId) : await downloadImage(imageUrl)

    await writeFile(dest, buf)
    index.images.set(dest.toLowerCase(), dest)

    return { ok: true, dest }
}

async function downloadImage(imageUrl) {
    if (!/^https:\/\//i.test(imageUrl || "")) throw new Error("expected an https image url")
    const res = await fetch(imageUrl)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const type = res.headers.get("content-type") || ""
    if (!type.startsWith("image/")) throw new Error(`source is not an image (${type || "unknown"})`)
    return downloadCapped(res, MAX_POSTER_BYTES)
}

// Resolve an upload token to its temp file. The token map is built server-side
// from uploads we wrote, so the path is never attacker-controlled.
async function readUpload(cfg, uploadId) {
    const tempPath = cfg.uploads?.get(uploadId)
    if (!tempPath) throw new Error("unknown or expired upload")
    return readFile(tempPath)
}

// Only paths discovered by the scan are writable: a video file, a subdirectory,
// or a library root (for the top-level fallback sidecar).
function isKnownTarget(index, target, isDir) {
    if (isDir) return index.dirs.has(target) || index.libraries.some((lib) => lib.path === target)
    return index.videos.some((v) => v.path === target)
}

// Read a response body into a Buffer, aborting if it exceeds `max` bytes.
async function downloadCapped(res, max) {
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > max) {
            await reader.cancel()
            throw new Error(`image exceeds ${max} bytes`)
        }
        chunks.push(value)
    }
    return Buffer.concat(chunks)
}
