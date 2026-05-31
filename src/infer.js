import path from "node:path"
import { parseName, parseSeason } from "./name.js"

// Guess what to search for from an item's location. TV is signalled by a season
// folder in the path, a TV-ish library name, or show/season/episode nesting.
// All of this is just a starting point — the UI lets the user flip type/title.
//
// Returns { type: "movie" | "tv", title, year, season }.
export function inferQuery(targetPath, isDir, root) {
    const rel = path.relative(root, targetPath)
    const parts = rel.split(path.sep).filter(Boolean)
    const libName = path.basename(root)

    const anySeason = parts.map(parseSeason).find((s) => s != null) ?? null
    const deep = parts.length > (isDir ? 1 : 2)
    const looksTv = anySeason != null || /\b(tv|shows?|series)\b/i.test(libName) || deep

    const ownBase = isDir ? path.basename(targetPath) : path.basename(targetPath, path.extname(targetPath))

    if (!looksTv) {
        const { title, year } = parseName(ownBase)
        return { type: "movie", title, year, season: null }
    }

    // The "show" is the folder that names the series, found relative to the item:
    //   - acting on a directory: that directory is the show (unless it's a season
    //     folder, in which case its parent is the show);
    //   - acting on an episode file: its containing folder is the show (or the
    //     folder above a season folder).
    // Categories like "Crafting" above the show folder are ignored — we never
    // reach for the topmost segment under the library root.
    const dirSegments = isDir ? parts : parts.slice(0, -1)

    let parsed = { title: ownBase, year: null }
    let season = null

    if (dirSegments.length === 0) {
        // Sits directly in the library root: the item names itself.
        parsed = parseName(ownBase)
    } else {
        const lastDir = dirSegments[dirSegments.length - 1]
        const lastSeason = parseSeason(lastDir)
        if (lastSeason != null && dirSegments.length >= 2) {
            parsed = parseName(dirSegments[dirSegments.length - 2])
            season = lastSeason
        } else {
            parsed = parseName(lastDir)
        }
    }

    return { type: "tv", title: parsed.title, year: parsed.year, season: season ?? anySeason }
}

// The path segments from the library root down to the item, each as a clickable
// search suggestion: `label` is the folder/file name shown, `value` is the
// cleaned title typed into the search box when clicked. The file's own extension
// is stripped. The library root itself is omitted (searching it is useless).
export function pathSegments(targetPath, isDir, root) {
    const rel = path.relative(root, targetPath)
    const raw = rel.split(path.sep).filter(Boolean)
    return raw.map((seg, i) => {
        const isFileLeaf = i === raw.length - 1 && !isDir
        const name = isFileLeaf ? seg.slice(0, seg.length - path.extname(seg).length) : seg
        return { label: name, value: parseName(name).title }
    })
}
