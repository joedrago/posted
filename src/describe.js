import { readFile, writeFile, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { inferQuery } from "./infer.js"
import { findMovie } from "./sources/tmdb.js"

// Fill in a missing `description` in each movie's sidecar JSON (<stem>.json, the
// file duplex reads) from TMDB's plot overview. Only `description` is ever added:
// every other key in an existing JSON is preserved as-is, a JSON that already has
// a description is left alone, and one that won't parse is never touched.
//
// Returns true when every item was handled cleanly (written or a benign skip),
// false if any hit a hard error — the caller maps that to the process exit code.
export async function fillDescriptions(index, cfg) {
    if (!cfg.tmdbKey) {
        log("error — no TMDB key configured (set TMDB_API_KEY or add it in the web UI settings)")
        return false
    }

    const counts = { written: 0, described: 0, notMovie: 0, noMatch: 0, noOverview: 0, badJson: 0, errors: 0 }

    for (const video of index.videos) {
        const dest = path.join(video.dir, video.name + ".json")
        const label = path.relative(video.root, video.path)

        const existing = await readSidecar(dest)
        if (existing.bad) {
            log(`skip — ${label}: ${existing.bad}`)
            counts.badJson++
            continue
        }
        if (typeof existing.data.description === "string" && existing.data.description.trim()) {
            counts.described++
            continue
        }

        const query = inferQuery(video.path, false, video.root)
        if (query.type !== "movie") {
            counts.notMovie++
            continue
        }

        try {
            const movie = await findMovie(cfg, query.title, query.year)
            if (!movie) {
                log(`skip — ${label}: no TMDB match for "${query.title}"${query.year ? ` (${query.year})` : ""}`)
                counts.noMatch++
                continue
            }
            const matched = movie.year ? `${movie.title} (${movie.year})` : movie.title
            if (!movie.overview) {
                log(`skip — ${label}: TMDB has no overview for ${matched}`)
                counts.noOverview++
                continue
            }

            await writeSidecar(dest, { ...existing.data, description: movie.overview })
            log(`wrote ${path.basename(dest)} ← ${matched}`)
            counts.written++
        } catch (err) {
            log(`error — ${label}: ${err.message}`)
            counts.errors++
        }
    }

    log(
        `descriptions: ${counts.written} written, ${counts.described} already had one, ` +
            `${counts.noMatch} unmatched, ${counts.noOverview} without an overview, ` +
            `${counts.badJson} unreadable JSON, ${counts.notMovie} non-movies, ${counts.errors} errors`
    )
    return counts.errors === 0
}

// The existing sidecar as { data } (an empty object when there's no file yet), or
// { bad: reason } when a file exists but isn't a JSON object we can safely extend.
async function readSidecar(dest) {
    let raw
    try {
        raw = await readFile(dest, "utf8")
    } catch (err) {
        if (err.code === "ENOENT") return { data: {} }
        return { bad: `cannot read ${path.basename(dest)}: ${err.message}` }
    }

    let data
    try {
        data = JSON.parse(raw)
    } catch {
        return { bad: `${path.basename(dest)} is not valid JSON` }
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return { bad: `${path.basename(dest)} is not a JSON object` }
    }
    return { data }
}

// Write via a hidden temp file + rename so neither a crash nor duplex's watcher
// can ever observe a truncated JSON (which would cost any hand-written keys).
async function writeSidecar(dest, data) {
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp`)
    try {
        await writeFile(tmp, JSON.stringify(data, null, 4) + "\n")
        await rename(tmp, dest)
    } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
    }
}

function log(msg) {
    process.stderr.write(`posted: ${msg}\n`)
}
