import { readdir } from "node:fs/promises"
import path from "node:path"

// Files we treat as videos that need a poster.
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".ts"])

// Sidecar image formats we recognize on disk, in resolution priority order.
// We always *write* .jpg, but an existing .jpeg/.png counts as a valid poster.
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"]

// Walk every library root and build an index of videos, directories, and
// existing sidecar images. Image lookups are case-insensitive (the key is a
// lowercased absolute path) so a "Movie.JPG" still matches "Movie.mp4"; the
// stored value is the real on-disk path for serving/overwriting.
export async function scanLibraries(libraryPaths) {
    const videos = []
    const images = new Map()
    const dirs = new Set()
    const libraries = []

    for (const raw of libraryPaths) {
        const root = path.resolve(raw)
        libraries.push({ path: root })
        await walk(root, root, { videos, images, dirs })
    }

    return { libraries, videos, images, dirs }
}

async function walk(dir, root, acc) {
    let entries
    try {
        entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
        // Unreadable directory: warn but keep scanning the rest of the tree.
        process.stderr.write(`posted: cannot read ${dir}: ${err.message}\n`)
        return
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            acc.dirs.add(full)
            await walk(full, root, acc)
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (VIDEO_EXTENSIONS.has(ext)) {
                acc.videos.push({ path: full, dir, name: path.basename(entry.name, path.extname(entry.name)), root })
            } else if (IMAGE_EXTENSIONS.includes(ext)) {
                acc.images.set(full.toLowerCase(), full)
            }
        }
        // Symlinks are skipped (isDirectory/isFile are false) to avoid cycles.
    }
}
