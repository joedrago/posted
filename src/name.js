// Common release/quality tags worth stripping before querying a poster source.
const TAG_RE =
    /\b(2160p|1080p|720p|480p|4k|x264|x265|h ?264|h ?265|hevc|bluray|blu-ray|brrip|bdrip|webrip|web-?dl|hdtv|dvdrip|aac|dts|ac3|remux|proper|repack)\b/gi

// A 4-digit year (1900-2099), the strongest disambiguator for movie searches.
const YEAR_RE = /\b(19|20)\d{2}\b/

// Turn a raw file or directory name into a search-friendly { title, year }.
// Handles the year either trailing the title ("Fight.Club.1999.1080p.BluRay")
// or leading it ("1961 - 101 Dalmatians").
export function parseName(rawName) {
    let s = rawName.replace(/[._]+/g, " ")

    const yearMatch = s.match(YEAR_RE)
    const year = yearMatch ? yearMatch[0] : null
    if (yearMatch) {
        const before = s.slice(0, yearMatch.index)
        const after = s.slice(yearMatch.index + yearMatch[0].length)
        // If the title text precedes the year, drop everything from the year on
        // (trailing quality tags). If nothing but separators precede the year, it
        // is a leading year — keep what follows instead.
        s = /[a-z]/i.test(before) ? before : after
    }

    s = s
        .replace(/[()[\]{}]/g, " ")
        .replace(TAG_RE, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[-–—\s]+|[-–—\s]+$/g, "")

    return { title: s, year }
}

// Detect a season number from a directory name like "S02" or "Season 2".
// Returns the integer season, or null.
export function parseSeason(rawName) {
    const m = rawName.match(/\b(?:s|season)\s*0*(\d{1,3})\b/i)
    return m ? Number(m[1]) : null
}
