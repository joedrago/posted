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

    const season = parts.map(parseSeason).find((s) => s != null) ?? null
    const libName = path.basename(root)
    const deep = parts.length > (isDir ? 1 : 2)
    const looksTv = season != null || /\b(tv|shows?|series)\b/i.test(libName) || deep

    if (looksTv) {
        // The show is the first path segment under the library root.
        const show = parts.length ? parseName(parts[0]).title : libName
        return { type: "tv", title: show, year: null, season }
    }

    const base = isDir ? path.basename(targetPath) : path.basename(targetPath, path.extname(targetPath))
    const { title, year } = parseName(base)
    return { type: "movie", title, year, season: null }
}
