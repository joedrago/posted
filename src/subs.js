import { spawn } from "node:child_process"
import { open, stat, readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

// Subtitle sidecar formats we recognize beside a video. Unlike posters there is
// no directory fallback — a subtitle only ever belongs to one specific file.
export const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".vtt"])

// Does any subtitle sidecar in the video's directory belong to this video? A
// sidecar belongs when its name (minus a subtitle extension) is exactly the
// video's basename or that basename followed by a language/qualifier tag — so
// "Movie.srt", "Movie.en.srt", and "Movie.forced.srt" all match a video "Movie".
// Matching is case-insensitive, mirroring the poster scan. Returns the real
// on-disk path of the first match, or null.
export function subSidecarFor(video, subsByDir) {
    const entries = subsByDir.get(video.dir)
    if (!entries) return null

    const nameLc = video.name.toLowerCase()
    for (const entry of entries) {
        const ext = path.extname(entry.name)
        if (!SUBTITLE_EXTENSIONS.has(ext.toLowerCase())) continue
        const stem = entry.name.slice(0, entry.name.length - ext.length).toLowerCase()
        if (stem === nameLc || stem.startsWith(nameLc + ".")) return entry.path
    }
    return null
}

// Resolve a video's subtitle status. A sidecar takes priority (it's the file we'd
// write/overwrite); otherwise an embedded track counts; otherwise none.
//
// Returns { kind: "sidecar" | "embedded" | "none", sidecar }.
export function resolveSubs(video, subsByDir) {
    const sidecar = subSidecarFor(video, subsByDir)
    if (sidecar) return { kind: "sidecar", sidecar }
    if (video.embeddedSubs) return { kind: "embedded", sidecar: null }
    return { kind: "none", sidecar: null }
}

// True if `file` carries at least one embedded subtitle track. ffprobe is asked
// to list only subtitle stream indexes; any output means a track is present.
// Resolves false (never rejects) when ffprobe is missing or errors, so a probe
// failure degrades to "needs subtitles" rather than breaking the whole scan.
export function probeEmbedded(file) {
    return new Promise((resolve) => {
        let out = ""
        let settled = false
        const finish = (val) => {
            if (settled) return
            settled = true
            resolve(val)
        }

        let child
        try {
            const args = ["-v", "error", "-select_streams", "s", "-show_entries", "stream=index", "-of", "csv=p=0", file]
            child = spawn("ffprobe", args)
        } catch {
            return finish(false)
        }
        child.stdout.on("data", (d) => (out += d))
        child.on("error", () => finish(false))
        child.on("close", () => finish(out.trim().length > 0))
    })
}

// Where we write a fetched subtitle: always <dir>/<basename>.srt beside the
// video, regardless of the video's container extension.
export function subDest(videoPath) {
    const ext = path.extname(videoPath)
    return videoPath.slice(0, videoPath.length - ext.length) + ".srt"
}

const HASH_CHUNK = 64 * 1024
const MOD64 = 1n << 64n

// OpenSubtitles "moviehash": a 64-bit value = filesize plus the 64-bit-word sum
// of the first and last 64KB of the file, returned as 16 lowercase hex digits.
// It lets OpenSubtitles return subtitles cut for this exact file — the best shot
// at a track that's already in sync. Returns null for files under 64KB or on a
// read error (the caller then falls back to a title query).
export async function computeMovieHash(file) {
    let fh
    try {
        const info = await stat(file)
        if (info.size < HASH_CHUNK) return null

        fh = await open(file, "r")
        let hash = BigInt(info.size)

        const head = Buffer.alloc(HASH_CHUNK)
        await fh.read(head, 0, HASH_CHUNK, 0)
        const tail = Buffer.alloc(HASH_CHUNK)
        await fh.read(tail, 0, HASH_CHUNK, info.size - HASH_CHUNK)

        for (let i = 0; i < HASH_CHUNK; i += 8) {
            hash = (hash + head.readBigUInt64LE(i)) % MOD64
            hash = (hash + tail.readBigUInt64LE(i)) % MOD64
        }
        return hash.toString(16).padStart(16, "0")
    } catch {
        return null
    } finally {
        await fh?.close()
    }
}

const CACHE_DIR = path.join(os.homedir(), ".config", "posted")
const CACHE_FILE = path.join(CACHE_DIR, "probe-cache.json")

// Persisted ffprobe results so rescans don't re-probe unchanged files. Keyed by
// absolute path → { size, mtimeMs, embedded }; a stored entry is trusted only
// when the file's current size and mtime still match (checked by the caller).
export async function loadProbeCache() {
    try {
        const raw = await readFile(CACHE_FILE, "utf8")
        return new Map(Object.entries(JSON.parse(raw)))
    } catch {
        return new Map()
    }
}

export async function saveProbeCache(cache) {
    try {
        await mkdir(CACHE_DIR, { recursive: true })
        await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)))
    } catch {
        // A non-writable cache is non-fatal — we just re-probe next run.
    }
}
