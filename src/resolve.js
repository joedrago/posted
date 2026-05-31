import path from "node:path"
import { IMAGE_EXTENSIONS } from "./scan.js"

// Look for an existing sidecar image at a given path stem (a path without an
// extension), trying each recognized image extension in priority order.
// Returns the real on-disk path, or null.
function sidecarFor(stem, images) {
    for (const ext of IMAGE_EXTENSIONS) {
        const actual = images.get((stem + ext).toLowerCase())
        if (actual) return actual
    }
    return null
}

// Resolve the effective poster for a video, following the same rules the media
// server uses:
//   1. A direct sidecar beside the file:  Movies/Fight Club.mp4 -> Movies/Fight Club.jpg
//   2. A directory fallback: climbing ancestors below the library root, a sidecar
//      named after a directory covers every video within it. The closest wins:
//      Scrubs/S02/S02E01.mp4 -> Scrubs/S02.jpg, else Scrubs.jpg.
//
// Returns { kind: "direct" | "fallback" | "missing", poster, viaDir }.
export function resolvePoster(video, images) {
    const { dir, name, root } = video

    const direct = sidecarFor(path.join(dir, name), images)
    if (direct) return { kind: "direct", poster: direct, viaDir: null }

    let d = dir
    while (isInside(d, root)) {
        const poster = sidecarFor(d, images)
        if (poster) return { kind: "fallback", poster, viaDir: d }
        d = path.dirname(d)
    }

    return { kind: "missing", poster: null, viaDir: null }
}

// Resolve the effective poster for a directory itself (used for folder cards in
// the gallery). A directory's own sidecar is <dir>.jpg; failing that it inherits
// from the nearest ancestor below the library root, exactly like a video does.
//
// Returns { kind: "direct" | "fallback" | "missing", poster, viaDir }.
export function resolveDirPoster(dirPath, root, images) {
    const own = sidecarFor(dirPath, images)
    if (own) return { kind: "direct", poster: own, viaDir: null }

    let d = path.dirname(dirPath)
    while (isInside(d, root)) {
        const poster = sidecarFor(d, images)
        if (poster) return { kind: "fallback", poster, viaDir: d }
        d = path.dirname(d)
    }

    return { kind: "missing", poster: null, viaDir: null }
}

// True when `child` is a strict descendant of `root`. The library root itself is
// excluded, so we never adopt a sidecar that sits outside the library.
function isInside(child, root) {
    const rel = path.relative(root, child)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}
