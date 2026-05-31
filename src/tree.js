import path from "node:path"
import { resolvePoster, resolveDirPoster } from "./resolve.js"

// Find the library root that contains `p` (or equals it). Returns null if `p`
// is not within any configured library — the basis for all path validation.
export function findRoot(index, p) {
    const target = path.resolve(p)
    for (const lib of index.libraries) {
        if (target === lib.path || isInside(target, lib.path)) return lib.path
    }
    return null
}

// The configured libraries, as cards for the gallery's top level.
export function listLibraries(index) {
    return index.libraries.map((lib) => ({
        type: "library",
        path: lib.path,
        name: path.basename(lib.path),
        ...posterFields(resolveDirPoster(lib.path, lib.path, index.images))
    }))
}

// Immediate children (subdirectories + videos) of a directory, each with its
// effective poster. Used to render one level of the browsable gallery.
export function listChildren(index, dirPath) {
    const root = findRoot(index, dirPath)
    if (root === null) return null

    const target = path.resolve(dirPath)
    const entries = []

    for (const dir of index.dirs) {
        if (path.dirname(dir) === target) {
            entries.push({
                type: "dir",
                path: dir,
                name: path.basename(dir),
                ...posterFields(resolveDirPoster(dir, root, index.images))
            })
        }
    }

    for (const video of index.videos) {
        if (video.dir === target) {
            entries.push({
                type: "video",
                path: video.path,
                name: video.name,
                ...posterFields(resolvePoster(video, index.images))
            })
        }
    }

    entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1
        return a.name.localeCompare(b.name)
    })

    return { path: target, root, breadcrumb: breadcrumbFor(root, target), entries }
}

// Every video with no resolvable poster, across all libraries — the flat list
// behind the "only missing" filter.
export function listMissing(index) {
    const missing = []
    for (const video of index.videos) {
        const res = resolvePoster(video, index.images)
        if (res.kind === "missing") {
            const root = video.root
            missing.push({
                type: "video",
                path: video.path,
                name: video.name,
                relative: path.relative(root, video.path),
                library: path.basename(root),
                ...posterFields(res)
            })
        }
    }
    missing.sort((a, b) => a.path.localeCompare(b.path))
    return missing
}

function posterFields(res) {
    return { posterKind: res.kind, poster: res.poster, viaDir: res.viaDir }
}

// Crumbs from the library root down to (and including) the target directory.
function breadcrumbFor(root, target) {
    const crumbs = [{ name: path.basename(root), path: root }]
    if (target === root) return crumbs

    const rel = path.relative(root, target)
    let acc = root
    for (const part of rel.split(path.sep)) {
        acc = path.join(acc, part)
        crumbs.push({ name: part, path: acc })
    }
    return crumbs
}

function isInside(child, root) {
    const rel = path.relative(root, child)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}
