import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { subDest, subSidecarFor } from "./subs.js"
import { fetchSubtitle } from "./sources/opensubtitles.js"

// Subtitle sync comparison. The sidecar the user is currently auditioning is the
// "reference"; for each other OpenSubtitles candidate we estimate how its timing
// differs from the reference. Method: sample distinctive lines spread across the
// reference, locate the same lines in the candidate by word overlap, and fit the
// resulting time deltas. A candidate comes back as a constant offset ("its lines
// appear 2.1s later than yours"), a linear drift (a framerate mismatch: "+0.3s at
// the start, +6.1s at the end"), or no usable match (a different cut, or a
// transcription too different to line up).

// How many reference lines to sample. They're spread over the middle 90% of the
// reference so the sparse opening/closing credits don't dominate.
const SAMPLE_COUNT = 12

// A sampled line must be at least this many words (after normalization) and occur
// only once in the reference, so "Yeah." can't match a dozen places.
const MIN_SAMPLE_WORDS = 4

// Word-multiset Dice similarity a candidate line must reach to count as "the same
// line". Two transcriptions of one utterance usually clear this; unrelated lines
// that share a few common words don't.
const MATCH_THRESHOLD = 0.6

// Sample deltas within this many seconds of the fitted line count as agreeing
// with it; the rest are treated as mismatches and excluded from the estimate.
const AGREE_TOLERANCE = 0.5

// Total drift across the sampled span below this is reported as a plain offset.
const MIN_DRIFT = 0.5

// Slopes are only estimated between samples at least this far apart, so two
// neighboring lines with a slightly noisy delta don't imply a wild drift.
const MIN_SLOPE_SPAN = 60

// Concurrent OpenSubtitles downloads while comparing.
const DOWNLOAD_CONCURRENCY = 3

// --- parsing ----------------------------------------------------------------

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g
const VTT_SHORT_TIME = /(\d{1,2}):(\d{2})[,.](\d{1,3})/g
const ASS_TIME = /(\d+):(\d{2}):(\d{2})[.:](\d{2})/

// Parse a subtitle file into [{ start, end, text }] with times in seconds, by
// extension: SubStation (.ass/.ssa) dialogue lines, else SRT/WebVTT cue blocks.
function parseCues(raw, ext) {
    const text = raw.replace(/^\uFEFF/, "")
    const cues = ext === ".ass" || ext === ".ssa" ? parseAss(text) : parseSrt(text)
    return cues.filter((c) => c.end >= c.start).sort((a, b) => a.start - b.start)
}

// SRT and WebVTT share the shape: a "start --> end" line followed by text lines
// up to a blank line. Index lines (SRT), the WEBVTT header, NOTE/STYLE blocks and
// cue settings after the times are all ignored by keying only on "-->" lines.
function parseSrt(text) {
    const cues = []
    let cue = null
    for (const line of text.split(/\r?\n/)) {
        if (line.includes("-->")) {
            const [start, end] = parseTimeline(line)
            cue = start != null && end != null ? { start, end, lines: [] } : null
            if (cue) cues.push(cue)
            continue
        }
        if (!cue) continue
        if (line.trim() === "") cue = null
        else cue.lines.push(line)
    }
    return cues.map((c) => ({ start: c.start, end: c.end, text: c.lines.join("\n") }))
}

function parseTimeline(line) {
    const [a, b] = line.split("-->")
    return [parseTimestamp(a), parseTimestamp(b)]
}

// "hh:mm:ss,mmm" (SRT), "hh:mm:ss.mmm" or "mm:ss.mmm" (WebVTT) → seconds.
function parseTimestamp(s) {
    SRT_TIME.lastIndex = 0
    let m = SRT_TIME.exec(s)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000
    VTT_SHORT_TIME.lastIndex = 0
    m = VTT_SHORT_TIME.exec(s)
    if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, "0")) / 1000
    return null
}

// SubStation "Dialogue:" lines: ten comma-separated fields, the last of which is
// the text and may itself contain commas. Times are h:mm:ss.cc (centiseconds).
function parseAss(text) {
    const cues = []
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("Dialogue:")) continue
        const fields = line.slice("Dialogue:".length).split(",")
        if (fields.length < 10) continue
        const start = parseAssTime(fields[1])
        const end = parseAssTime(fields[2])
        if (start == null || end == null) continue
        cues.push({ start, end, text: fields.slice(9).join(",").replace(/\\N/g, "\n") })
    }
    return cues
}

function parseAssTime(s) {
    const m = ASS_TIME.exec(s.trim())
    if (!m) return null
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100
}

// --- text matching ----------------------------------------------------------

// Reduce a cue's text to a sorted list of lowercase words so two transcriptions
// of the same line compare on content alone. Stripped: markup (<i>, {\an8}),
// hearing-impaired annotations ([door slams], (sighs)) and speaker labels
// ("JOHN:"), dialogue dashes and all punctuation.
export function normalizeWords(text) {
    const cleaned = text
        .replace(/<[^>]*>/g, " ")
        .replace(/\{[^}]*\}/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/^[\s-]*[A-Z][A-Z .'-]{1,30}:/gm, " ")
        .toLowerCase()
    return cleaned
        .split(/[^\p{L}\p{N}']+/u)
        .filter(Boolean)
        .sort()
}

// Number of words two sorted word lists have in common (multiset intersection).
function overlap(a, b) {
    let i = 0
    let j = 0
    let n = 0
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            n++
            i++
            j++
        } else if (a[i] < b[j]) i++
        else j++
    }
    return n
}

function dice(a, b) {
    if (a.length === 0 || b.length === 0) return 0
    return (2 * overlap(a, b)) / (a.length + b.length)
}

function mergeSorted(a, b) {
    return a.concat(b).sort()
}

// Parse a subtitle file and attach normalized words to each cue. `pair` is the
// words of this cue joined with the next one, so a line the reference keeps
// whole still matches a candidate that split it in two.
export function loadCues(raw, ext) {
    const out = parseCues(raw, ext).map((c) => ({ ...c, words: normalizeWords(c.text) }))
    for (let i = 0; i < out.length; i++) {
        out[i].pair = i + 1 < out.length ? mergeSorted(out[i].words, out[i + 1].words) : out[i].words
    }
    return out
}

// Choose the reference lines to look for: for each of SAMPLE_COUNT evenly spaced
// points across the middle 90% of the reference, the nearest not-yet-taken line
// that is long enough and unique within the file. Falls back to shorter lines
// when the file is too sparse for enough long ones.
export function pickSamples(cues, count = SAMPLE_COUNT) {
    if (cues.length === 0) return []
    const freq = new Map()
    for (const c of cues) {
        const key = c.words.join(" ")
        freq.set(key, (freq.get(key) || 0) + 1)
    }
    const unique = cues.filter((c) => c.words.length >= 2 && freq.get(c.words.join(" ")) === 1)
    let pool = unique.filter((c) => c.words.length >= MIN_SAMPLE_WORDS)
    if (pool.length < count) pool = unique
    if (pool.length === 0) return []

    const first = cues[0].start
    const span = cues[cues.length - 1].start - first
    const taken = new Set()
    const picked = []
    for (let i = 0; i < count; i++) {
        const t = first + span * (0.05 + (0.9 * i) / Math.max(1, count - 1))
        let best = null
        for (const c of pool) {
            if (taken.has(c)) continue
            if (!best || Math.abs(c.start - t) < Math.abs(best.start - t)) best = c
        }
        if (!best) break
        taken.add(best)
        picked.push(best)
    }
    return picked.sort((a, b) => a.start - b.start)
}

// Find where a sampled reference line appears in a candidate file. Every
// candidate line (and each line joined with its successor) is scored; the best
// score wins. Exact ties (the same line said twice) go to the instance nearest
// the sample's own time — only exact ones, since preferring a nearby but
// slightly worse match would drag every delta toward zero and hide a drift.
// Returns the candidate start time and score, or null when nothing reaches
// MATCH_THRESHOLD.
function locate(sample, cues) {
    let best = null
    for (const c of cues) {
        const score = Math.max(dice(sample.words, c.words), dice(sample.words, c.pair))
        if (score < MATCH_THRESHOLD) continue
        const closer = best && score === best.score && Math.abs(c.start - sample.start) < Math.abs(best.at - sample.start)
        if (!best || score > best.score || closer) best = { score, at: c.start }
    }
    return best
}

// --- fitting ----------------------------------------------------------------

function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Robust slope of delta over time (Theil–Sen: median of pairwise slopes).
function theilSen(points) {
    const slopes = []
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const dt = points[j].at - points[i].at
            if (dt >= MIN_SLOPE_SPAN) slopes.push((points[j].offset - points[i].offset) / dt)
        }
    }
    return slopes.length ? median(slopes) : 0
}

// Fit offset = intercept + slope·t through the deltas with the slope fixed: the
// intercept is the median residual, re-centered on the points that land within
// AGREE_TOLERANCE of it so one stray mismatch doesn't skew the number.
function fitLine(points, slope) {
    let intercept = median(points.map((p) => p.offset - slope * p.at))
    const agreeing = points.filter((p) => Math.abs(p.offset - (intercept + slope * p.at)) <= AGREE_TOLERANCE)
    if (agreeing.length) intercept = median(agreeing.map((p) => p.offset - slope * p.at))
    return { slope, intercept, agreeing }
}

// Turn per-sample deltas (candidate time minus reference time) into a verdict:
//   kind "offset":       a constant shift, `offset` seconds (+ = candidate is later)
//   kind "drift":        a linear drift; `start`/`end` give the shift at the first
//                        and last matched sample times
//   kind "inconsistent": lines were found but fewer than two deltas agree
//   kind "none":         no sample matched
// Two hypotheses are scored by how many samples they explain — a constant shift,
// and (given enough samples) a linear drift with a Theil–Sen slope. Drift only
// wins when it explains strictly more, so a step change (an extended cut) stays a
// majority-vote offset instead of becoming a bogus slope. Confidence is "high"
// when at least three samples agree and they're the clear majority of matches.
export function estimateSync(samples) {
    const matched = samples.filter((s) => s.offset != null)
    if (matched.length === 0) return { kind: "none", matched: 0, agree: 0, confidence: "none" }

    let fit = fitLine(matched, 0)
    if (matched.length >= 3) {
        const slope = theilSen(matched)
        const span = matched[matched.length - 1].at - matched[0].at
        if (Math.abs(slope * span) >= MIN_DRIFT) {
            const drift = fitLine(matched, slope)
            if (drift.agreeing.length > fit.agreeing.length) fit = drift
        }
    }

    const agree = fit.agreeing.length
    if (agree < 2) return { kind: "inconsistent", matched: matched.length, agree, confidence: "none" }

    const confidence = agree >= 3 && agree >= 0.75 * matched.length ? "high" : "low"
    const base = { matched: matched.length, agree, confidence }
    if (fit.slope === 0) return { kind: "offset", offset: fit.intercept, ...base }

    const first = matched[0].at
    const last = matched[matched.length - 1].at
    return {
        kind: "drift",
        start: { at: first, offset: fit.intercept + fit.slope * first },
        end: { at: last, offset: fit.intercept + fit.slope * last },
        ...base
    }
}

// Locate each sampled reference line in a candidate's cues and fit the deltas.
// The per-sample deltas ride along for the UI's detail view.
export function compareCues(samples, cues) {
    const deltas = samples.map((s) => {
        const hit = locate(s, cues)
        return { at: s.start, offset: hit ? hit.at - s.start : null, score: hit ? hit.score : 0 }
    })
    return { ...estimateSync(deltas), samples: deltas }
}

// --- driver -----------------------------------------------------------------

// The sidecar to compare against: the <basename>.srt the picker writes, else any
// other sidecar the scan found for this video.
function referencePath(index, video) {
    const dest = subDest(video.path)
    if (existsSync(dest)) return dest
    return subSidecarFor(video, index.subsByDir)
}

// Compare the video's current sidecar against each OpenSubtitles file id. Per
// candidate: the sync estimate plus the sampled lines with their individual
// deltas (for the UI's detail view), or an `error` when the download/parse
// failed. Candidates are fetched through the download cache with limited
// concurrency; one failure doesn't stop the others.
export async function compareSubtitles(index, cfg, video, fileIds) {
    const refPath = referencePath(index, video)
    if (!refPath) throw new Error("no subtitle sidecar to compare against — save one first")

    const ext = path.extname(refPath).toLowerCase()
    const refCues = loadCues(await readFile(refPath, "utf8"), ext)
    if (refCues.length === 0) throw new Error(`could not parse any cues from ${path.basename(refPath)}`)
    const samples = pickSamples(refCues)
    if (samples.length === 0) throw new Error(`${path.basename(refPath)} has no distinctive lines to sample`)

    let remaining = null
    const results = new Array(fileIds.length)
    const compareOne = async (i) => {
        const fileId = fileIds[i]
        try {
            const fetched = await fetchSubtitle(cfg, fileId)
            if (fetched.remaining != null) remaining = fetched.remaining
            const cues = loadCues(fetched.buffer.toString("utf8"), ".srt")
            results[i] = { fileId, ...compareCues(samples, cues) }
        } catch (err) {
            results[i] = { fileId, kind: "error", error: err.message }
        }
    }

    let next = 0
    const workers = []
    for (let w = 0; w < Math.min(DOWNLOAD_CONCURRENCY, fileIds.length); w++) {
        workers.push(
            (async () => {
                while (next < fileIds.length) await compareOne(next++)
            })()
        )
    }
    await Promise.all(workers)

    return {
        reference: { path: refPath, cues: refCues.length, samples: samples.map((s) => s.start) },
        results,
        remaining
    }
}
