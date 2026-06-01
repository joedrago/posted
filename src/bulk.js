import path from "node:path"
import { statSync, existsSync } from "node:fs"
import { VIDEO_EXTENSIONS, IMAGE_EXTENSIONS } from "./scan.js"
import { resolvePoster, resolveDirPoster } from "./resolve.js"
import { inferQuery } from "./infer.js"
import { searchPosters } from "./search.js"
import { applyPoster } from "./write.js"
import { findRoot } from "./tree.js"

// Headless equivalent of the UI's "Bulk Fix" for a single item: no scan, no web
// server. We locate the item inside a configured library, apply the same poster
// rules the gallery uses (skip anything that already has its own sidecar), and
// when one is missing we search the appropriate database and write the top hit.
//
// Returns true when the item was handled cleanly (poster written, or a benign
// skip), false on a hard error — the caller maps that to the process exit code.
export async function bulkFix({ libraries, target: rawTarget, cfg }) {
    const target = path.resolve(rawTarget)

    let st
    try {
        st = statSync(target)
    } catch {
        log(`error — no such file or directory: ${target}`)
        return false
    }

    const isDir = st.isDirectory()
    if (!isDir && !VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase())) {
        log(`error — not a recognized video file: ${target}`)
        return false
    }

    // Reuse findRoot for path validation: the target must sit inside a library so
    // inference and the apply gates behave exactly as they do under the UI.
    const libIndex = { libraries: libraries.map((p) => ({ path: path.resolve(p) })) }
    const root = findRoot(libIndex, target)
    if (!root) {
        log(`error — ${target} is not inside any --library`)
        return false
    }

    // Probe only the sidecar locations resolvePoster would consult, then run the
    // real resolver so the "already has a poster" decision is identical to the UI.
    const dir = path.dirname(target)
    const name = path.basename(target, path.extname(target))
    const video = { path: target, dir, name, root }
    const images = probeSidecars(target, isDir, dir, name, root)
    const res = isDir ? resolveDirPoster(target, root, images) : resolvePoster(video, images)

    const label = isDir ? path.basename(target) : name
    if (res.kind === "direct") {
        log(`skip — ${label} already has its own poster: ${res.poster}`)
        return true
    }

    // Only now do we actually need a source — a clean skip above never required one.
    if (!cfg.tmdbKey) {
        log("error — no poster source configured (set TMDB_API_KEY or add it in the web UI settings)")
        return false
    }

    const query = inferQuery(target, isDir, root)
    log(`looking up ${describe(query)}`)

    try {
        const { candidates } = await searchPosters(cfg, query)
        const top = candidates[0]
        if (!top) {
            log(`skip — no poster candidates found for "${query.title}"`)
            return true
        }

        // A one-item index so applyPoster's in-library / known-target gates pass.
        const index = {
            libraries: libIndex.libraries,
            videos: isDir ? [] : [video],
            dirs: isDir ? new Set([target]) : new Set(),
            images
        }
        const result = await applyPoster(index, cfg, { targetPath: target, isDir, imageUrl: top.url, overwrite: false })
        if (result.needsConfirm) {
            // Shouldn't happen for a missing/fallback item, but never clobber.
            log(`skip — poster already exists: ${result.existing}`)
            return true
        }

        log(`set poster ${result.dest} (from ${top.source}${top.label ? `: ${top.label}` : ""})`)
        return true
    } catch (err) {
        log(`error — ${err.message}`)
        return false
    }
}

// Build the image map resolvePoster/resolveDirPoster need, limited to the stems
// they actually look up: the item's own sidecar plus each ancestor directory
// strictly inside the library root. Mirrors scan.js's case-insensitive keying.
function probeSidecars(target, isDir, dir, name, root) {
    const stems = []
    if (isDir) {
        stems.push(target)
        for (let d = path.dirname(target); isInside(d, root); d = path.dirname(d)) stems.push(d)
    } else {
        stems.push(path.join(dir, name))
        for (let d = dir; isInside(d, root); d = path.dirname(d)) stems.push(d)
    }

    const images = new Map()
    for (const stem of stems) {
        for (const ext of IMAGE_EXTENSIONS) {
            const p = stem + ext
            if (existsSync(p)) images.set(p.toLowerCase(), p)
        }
    }
    return images
}

function describe(query) {
    const kind = query.type === "tv" ? "TV" : "movie"
    const year = query.year ? ` (${query.year})` : ""
    const season = query.season != null ? ` season ${query.season}` : ""
    return `${kind} "${query.title}"${year}${season}`
}

function log(msg) {
    process.stderr.write(`posted: ${msg}\n`)
}

// A strict descendant of root (root itself excluded), matching resolve.js so the
// fallback climb visits exactly the same ancestors.
function isInside(child, root) {
    const rel = path.relative(root, child)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}
