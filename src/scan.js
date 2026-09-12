import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { SUBTITLE_EXTENSIONS, subSidecarFor, probeEmbedded, loadProbeCache, saveProbeCache } from "./subs.js"

// Files we treat as videos that need a poster.
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".ts"])

// Sidecar image formats we recognize on disk, in resolution priority order.
// We always *write* .jpg, but an existing .jpeg/.png counts as a valid poster.
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"]

// How many ffprobe processes to keep in flight during the embedded-subtitle scan.
const PROBE_CONCURRENCY = 8

// Walk every library root and build an index of videos, directories, and
// existing sidecar images. Image lookups are case-insensitive (the key is a
// lowercased absolute path) so a "Movie.JPG" still matches "Movie.mp4"; the
// stored value is the real on-disk path for serving/overwriting.
//
// With `subs` set, we also collect subtitle sidecars (grouped by directory) and,
// for any video without one, probe its container for embedded subtitle tracks so
// the UI can flag what still needs English subtitles.
export async function scanLibraries(libraryPaths, { onProgress, subs = false } = {}) {
    const videos = []
    const images = new Map()
    const dirs = new Set()
    const subsByDir = new Map()
    const libraries = []
    const stats = { lib: null, dirs: 0, videos: 0, images: 0, subs: subs ? 0 : null }

    for (const raw of libraryPaths) {
        const root = path.resolve(raw)
        libraries.push({ path: root })
        stats.lib = path.basename(root)
        await walk(root, root, { videos, images, dirs, subsByDir, stats, subs, onProgress })
    }

    if (subs) await probeEmbeddedSubs({ videos, subsByDir, onProgress })

    onProgress?.({ ...stats, done: true })
    return { libraries, videos, images, dirs, subsByDir, subsEnabled: Boolean(subs) }
}

async function walk(dir, root, acc) {
    let entries
    try {
        entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
        // Unreadable directory: warn but keep scanning the rest of the tree.
        process.stderr.write(`\nposted: cannot read ${dir}: ${err.message}\n`)
        return
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            acc.dirs.add(full)
            acc.stats.dirs++
            await walk(full, root, acc)
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (VIDEO_EXTENSIONS.has(ext)) {
                acc.videos.push({ path: full, dir, name: path.basename(entry.name, path.extname(entry.name)), root })
                acc.stats.videos++
            } else if (IMAGE_EXTENSIONS.includes(ext)) {
                acc.images.set(full.toLowerCase(), full)
                acc.stats.images++
            } else if (acc.subs && SUBTITLE_EXTENSIONS.has(ext)) {
                let list = acc.subsByDir.get(dir)
                if (!list) acc.subsByDir.set(dir, (list = []))
                list.push({ name: entry.name, path: full })
                acc.stats.subs++
            }
        }
        // Symlinks are skipped (isDirectory/isFile are false) to avoid cycles.
    }

    // Report once per directory; the consumer throttles its own output.
    acc.onProgress?.(acc.stats)
}

// Determine, for every video lacking a subtitle sidecar, whether its container
// already carries an embedded subtitle track. Results are cached on disk keyed by
// path+size+mtime, so only new/changed files are actually probed on a rescan.
// Each video gets a boolean `embeddedSubs`; sidecar'd videos skip probing since a
// sidecar already counts as "subtitled".
async function probeEmbeddedSubs({ videos, subsByDir, onProgress }) {
    const cache = await loadProbeCache()

    const pending = []
    for (const video of videos) {
        if (subSidecarFor(video, subsByDir)) {
            video.embeddedSubs = false
        } else {
            pending.push(video)
        }
    }

    const total = pending.length
    let done = 0
    let next = 0

    async function worker() {
        while (next < pending.length) {
            const video = pending[next++]
            video.embeddedSubs = await probeOne(video.path, cache)
            done++
            onProgress?.({ phase: "probe", probed: done, total })
        }
    }

    const workers = []
    for (let i = 0; i < Math.min(PROBE_CONCURRENCY, total); i++) workers.push(worker())
    await Promise.all(workers)

    await saveProbeCache(cache)
    onProgress?.({ phase: "probe", probed: done, total, doneProbing: true })
}

async function probeOne(file, cache) {
    let info
    try {
        info = await stat(file)
    } catch {
        return false
    }
    const mtimeMs = Math.round(info.mtimeMs)
    const cached = cache.get(file)
    if (cached && cached.size === info.size && cached.mtimeMs === mtimeMs) return cached.embedded

    const embedded = await probeEmbedded(file)
    cache.set(file, { size: info.size, mtimeMs, embedded })
    return embedded
}
