// posted — gallery + poster picker (milestone 3).
// Browse libraries, filter to missing posters, and click an item to search TMDB
// and write a chosen poster (with overwrite confirmation).

const grid = document.getElementById("grid")
const breadcrumb = document.getElementById("breadcrumb")
const status = document.getElementById("status")
const missingToggle = document.getElementById("missing-only")
const hideDirsToggle = document.getElementById("hide-dirs")
const subsOnlyToggle = document.getElementById("subs-only")
const subsFilter = document.getElementById("subs-filter")
const sortToggle = document.getElementById("sort-toggle")

const modal = document.getElementById("modal")
const modalTitle = document.getElementById("modal-title")
const modalTarget = document.getElementById("modal-target")
const modalCurrent = document.getElementById("modal-current-poster")
const candidatesEl = document.getElementById("candidates")
const typeToggle = document.getElementById("type-toggle")
const titleInput = document.getElementById("search-title")
const seasonInput = document.getElementById("search-season")
const pathSegmentsEl = document.getElementById("path-segments")

const state = {
    path: null, // current directory when browsing; null = library list
    missingOnly: false,
    subsOnly: false, // "needs subtitles" filter (only when subs mode is enabled)
    hideDirs: false,
    sort: "alpha", // "alpha" (folders first, then A–Z) or "recent" (newest mtime first)
    picker: null, // the entry open in the poster modal
    subsEnabled: false, // server started with --subs
    subsPicker: null, // the entry open in the subtitle modal
    subsWrote: false, // a subtitle was written this picker session (refresh on close)
    subsOverwriteOk: false, // user is iterating — overwrite this session's .srt silently

    // Sync check: the candidates last listed (for neighbor selection), which one
    // is written on disk, and per-fileId comparison results against that file.
    subsCandidates: [],
    subsAppliedFileId: null,
    subsSync: new Map(),

    libraries: [] // cached library roots, for breadcrumbs in filtered views
}

async function getJson(url, opts) {
    const res = await fetch(url, opts)
    const body = await res.json().catch(() => ({}))
    if (!res.ok && res.status !== 409) throw new Error(body.error || res.statusText)
    return { status: res.status, body }
}

function posterUrl(entry) {
    if (entry.posterKind === "missing") return null
    const v = entry.posterVersion ? `&v=${entry.posterVersion}` : ""
    return `/api/poster?path=${encodeURIComponent(entry.poster)}${v}`
}

function basename(p) {
    return p.split("/").filter(Boolean).pop() || p
}

// --- gallery ---------------------------------------------------------------

function makeCard(entry) {
    const card = document.createElement("div")
    card.className = `card ${entry.type === "video" ? "video" : "folder"}`

    const poster = document.createElement("div")
    poster.className = "poster"
    const src = posterUrl(entry)
    if (src) {
        const img = document.createElement("img")
        img.loading = "lazy"
        img.src = src
        poster.appendChild(img)
    } else {
        const ph = document.createElement("div")
        ph.className = "placeholder"
        ph.textContent = "no poster"
        poster.appendChild(ph)
    }

    const badge = document.createElement("span")
    badge.className = `badge ${entry.posterKind}`
    badge.textContent = entry.posterKind === "fallback" ? "inherited" : entry.posterKind === "direct" ? "poster" : "missing"
    if (entry.posterKind === "fallback" && entry.viaDir) badge.title = `inherited from ${basename(entry.viaDir)}`
    poster.appendChild(badge)

    // Subtitle overlay (only in --subs mode, only on videos): a status badge plus
    // hover buttons to find English subtitles and to play the file in VLC.
    if (entry.type === "video" && state.subsEnabled) {
        const has = entry.subKind && entry.subKind !== "none"
        const sub = document.createElement("span")
        sub.className = `sub-badge ${has ? "has" : "none"}`
        sub.textContent = has ? "subs" : "needs subs"
        sub.title =
            entry.subKind === "embedded"
                ? "embedded subtitle track"
                : entry.subKind === "sidecar"
                  ? "subtitle sidecar"
                  : "no subtitles"
        poster.appendChild(sub)

        const actions = document.createElement("div")
        actions.className = "card-actions"

        const cc = document.createElement("button")
        cc.className = "act-btn"
        cc.textContent = "CC"
        cc.title = "Find English subtitles"
        cc.addEventListener("click", (e) => {
            e.stopPropagation()
            openSubsPicker(entry)
        })

        const play = document.createElement("button")
        play.className = "act-btn"
        play.textContent = "▶"
        play.title = "Play in VLC"
        play.addEventListener("click", (e) => {
            e.stopPropagation()
            playInVlc(entry)
        })

        actions.append(cc, play)
        poster.appendChild(actions)
    }

    if (entry.type !== "video") {
        const icon = document.createElement("span")
        icon.className = "folder-icon"
        icon.textContent = "▸"
        poster.appendChild(icon)

        const edit = document.createElement("button")
        edit.className = "edit-btn"
        edit.textContent = "✎"
        edit.title = "Set this folder's poster"
        edit.addEventListener("click", (e) => {
            e.stopPropagation()
            openPicker(entry)
        })
        poster.appendChild(edit)
    }

    const label = document.createElement("div")
    label.className = "label"
    label.textContent = entry.name
    if (entry.relative) {
        const sub = document.createElement("span")
        sub.className = "sub"
        sub.textContent = `${entry.library} / ${entry.relative}`
        label.appendChild(sub)
    }

    card.append(poster, label)

    card.addEventListener("click", () => {
        if (entry.type === "video") openPicker(entry)
        else navigate(entry.path)
    })

    return card
}

function renderBreadcrumb(crumbs) {
    breadcrumb.replaceChildren()
    const home = document.createElement("a")
    home.textContent = "Libraries"
    home.addEventListener("click", () => navigate(null))
    breadcrumb.appendChild(home)

    for (const crumb of crumbs || []) {
        const sep = document.createElement("span")
        sep.className = "sep"
        sep.textContent = "/"
        const link = document.createElement("a")
        link.textContent = crumb.name
        link.addEventListener("click", () => navigate(crumb.path))
        breadcrumb.append(sep, link)
    }
}

// Order entries for display. "recent" sorts purely by modification time (newest
// first) so freshly added media surfaces regardless of type; "alpha" keeps the
// server's default of folders before videos, then by name. Both tie-break on
// name for a stable, readable order.
function sortEntries(entries) {
    const list = [...entries]
    if (state.sort === "recent") {
        list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name))
    } else {
        list.sort((a, b) => {
            if ((a.type === "video") !== (b.type === "video")) return a.type === "video" ? 1 : -1
            return a.name.localeCompare(b.name)
        })
    }
    return list
}

function renderGrid(entries) {
    // "Hide directories" drops folder entries (libraries stay so the root remains
    // navigable). Filtering here means Bulk Fix also only sees what's visible.
    const visible = state.hideDirs ? entries.filter((e) => e.type !== "dir") : entries
    const sorted = sortEntries(visible)
    state.entries = sorted
    grid.replaceChildren()
    for (const entry of sorted) grid.appendChild(makeCard(entry))
}

async function navigate(targetPath) {
    state.path = targetPath
    await render()
}

// The flat "missing"/"needs subtitles" views are scoped to the directory you're
// browsing (state.path); at the library list (null) they span everything.
function scopeQuery() {
    return state.path ? `?path=${encodeURIComponent(state.path)}` : ""
}

function scopeLabel() {
    return state.path ? ` in ${basename(state.path)}` : ""
}

// Crumbs from the containing library root down to state.path, rebuilt client-side
// from the cached library list so a filtered view still shows (and can re-scope
// via) the breadcrumb.
function crumbsFor(targetPath) {
    const root = state.libraries.find((l) => targetPath === l.path || targetPath.startsWith(l.path + "/"))
    if (!root) return []
    const crumbs = [{ name: root.name, path: root.path }]
    let acc = root.path
    for (const part of targetPath.slice(root.path.length).split("/")) {
        if (!part) continue
        acc = `${acc}/${part}`
        crumbs.push({ name: part, path: acc })
    }
    return crumbs
}

// In a filtered view, keep the breadcrumb visible when scoped to a directory (so
// the scope is clear and clickable); hide it at the top-level all-libraries view.
function renderScopeBreadcrumb() {
    if (state.path) {
        breadcrumb.style.visibility = "visible"
        renderBreadcrumb(crumbsFor(state.path))
    } else {
        breadcrumb.style.visibility = "hidden"
    }
}

async function render() {
    try {
        if (state.missingOnly) {
            renderScopeBreadcrumb()
            const { body } = await getJson(`/api/missing${scopeQuery()}`)
            renderGrid(body)
            status.textContent = `${body.length} videos missing a poster${scopeLabel()}`
            return
        }

        if (state.subsOnly) {
            renderScopeBreadcrumb()
            const { body } = await getJson(`/api/subs/missing${scopeQuery()}`)
            renderGrid(body)
            status.textContent = `${body.length} videos missing subtitles${scopeLabel()}`
            return
        }

        breadcrumb.style.visibility = "visible"

        if (state.path === null) {
            renderBreadcrumb(null)
            const { body } = await getJson("/api/libraries")
            renderGrid(body)
            status.textContent = `${body.length} libraries`
            return
        }

        const { body } = await getJson(`/api/tree?path=${encodeURIComponent(state.path)}`)
        renderBreadcrumb(body.breadcrumb)
        renderGrid(body.entries)
        const videos = body.entries.filter((e) => e.type === "video").length
        const folders = body.entries.length - videos
        status.textContent =
            state.hideDirs && folders ? `${videos} videos (${folders} folders hidden)` : `${folders} folders, ${videos} videos`
    } catch (err) {
        status.textContent = `error: ${err.message}`
    }
}

// --- picker modal ----------------------------------------------------------

function setActiveType(type) {
    for (const btn of typeToggle.querySelectorAll("button")) {
        btn.classList.toggle("active", btn.dataset.type === type)
    }
    seasonInput.style.display = type === "tv" ? "" : "none"
}

function openPicker(entry) {
    state.picker = entry
    modalTitle.textContent = entry.type === "video" ? entry.name : `${entry.name} (folder)`
    modalTarget.textContent = entry.path

    modalCurrent.replaceChildren()
    const src = posterUrl(entry)
    if (src) {
        const img = document.createElement("img")
        img.src = src
        modalCurrent.appendChild(img)
    } else {
        const ph = document.createElement("div")
        ph.className = "placeholder"
        ph.textContent = "no poster"
        modalCurrent.appendChild(ph)
    }

    candidatesEl.replaceChildren()
    pathSegmentsEl.replaceChildren()
    modal.classList.remove("hidden")
    runSearch() // initial search using server-inferred title/type/season
}

function closePicker() {
    modal.classList.add("hidden")
    state.picker = null
}

function currentType() {
    return typeToggle.querySelector("button.active")?.dataset.type || "movie"
}

async function runSearch(useInferred = true) {
    const entry = state.picker
    if (!entry) return

    const params = new URLSearchParams({
        path: entry.path,
        isDir: entry.type === "video" ? "0" : "1"
    })
    // After the first (inferred) search the form drives the query.
    if (!useInferred) {
        params.set("type", currentType())
        if (titleInput.value.trim()) params.set("title", titleInput.value.trim())
        if (currentType() === "tv" && seasonInput.value !== "") params.set("season", seasonInput.value)
    }

    candidatesEl.replaceChildren(message("Searching…"))
    try {
        const { body } = await getJson(`/api/search?${params.toString()}`)
        if (useInferred && body.query) {
            setActiveType(body.query.type)
            titleInput.value = body.query.title || ""
            seasonInput.value = body.query.season ?? ""
        }
        renderSegments(body.segments)
        renderCandidates(body.candidates)
    } catch (err) {
        candidatesEl.replaceChildren(message(`error: ${err.message}`))
    }
}

// Clickable path chips: each types its cleaned segment into the search box and
// re-runs the search. The chip matching the current title is highlighted.
function renderSegments(segments) {
    pathSegmentsEl.replaceChildren()
    if (!segments || segments.length === 0) return

    segments.forEach((seg, i) => {
        if (i > 0) {
            const sep = document.createElement("span")
            sep.className = "sep"
            sep.textContent = "›"
            pathSegmentsEl.appendChild(sep)
        }
        const btn = document.createElement("button")
        btn.className = "seg-btn"
        btn.textContent = seg.label
        btn.title = `Search "${seg.value}"`
        if (seg.value && seg.value === titleInput.value.trim()) btn.classList.add("active")
        btn.addEventListener("click", () => {
            titleInput.value = seg.value
            for (const b of pathSegmentsEl.querySelectorAll(".seg-btn")) b.classList.remove("active")
            btn.classList.add("active")
            runSearch(false)
        })
        pathSegmentsEl.appendChild(btn)
    })
}

function renderCandidates(candidates) {
    candidatesEl.replaceChildren()
    if (!candidates || candidates.length === 0) {
        candidatesEl.appendChild(message("No posters found. Try editing the title or switching Movie/TV."))
        return
    }
    for (const cand of candidates) {
        const el = document.createElement("div")
        el.className = "candidate"

        // Same wrapper pattern as the gallery cards: the .poster div carries the
        // 2:3 aspect-ratio (reliable even inside the modal's flex/overflow box),
        // and the image fills it with object-fit: cover.
        const box = document.createElement("div")
        box.className = "poster"
        const img = document.createElement("img")
        img.loading = "lazy"
        img.src = cand.thumb
        box.appendChild(img)

        if (cand.source) {
            const src = document.createElement("span")
            src.className = `src-badge ${cand.source}`
            src.textContent = cand.source
            box.appendChild(src)
        }
        el.appendChild(box)

        const meta = document.createElement("div")
        meta.className = "meta"
        const dims = cand.width && cand.height ? `${cand.width}×${cand.height}` : ""
        meta.textContent = [cand.label, dims].filter(Boolean).join(" · ")
        el.appendChild(meta)

        el.addEventListener("click", () => applyPoster({ imageUrl: cand.url }))
        candidatesEl.appendChild(el)
    }
}

// `source` is either { imageUrl } (a candidate) or { uploadId } (a local upload).
async function applyPoster(source, overwrite = false) {
    const entry = state.picker
    if (!entry) return

    const payload = {
        targetPath: entry.path,
        isDir: entry.type !== "video",
        ...source,
        overwrite
    }

    try {
        const { status, body } = await getJson("/api/apply", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        })

        if (status === 409 && body.needsConfirm) {
            if (window.confirm(`Overwrite the existing poster?\n\n${body.existing}`)) {
                return applyPoster(source, true)
            }
            return
        }

        closePicker()
        await render()
    } catch (err) {
        candidatesEl.replaceChildren(message(`error: ${err.message}`))
    }
}

// Upload a local image for the open target, then apply it through the same flow.
async function uploadAndApply(file) {
    try {
        candidatesEl.replaceChildren(message(`Uploading ${file.name}…`))
        const res = await fetch("/api/upload", { method: "POST", headers: { "content-type": file.type }, body: file })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || res.statusText)
        await applyPoster({ uploadId: body.uploadId })
    } catch (err) {
        candidatesEl.replaceChildren(message(`error: ${err.message}`))
    }
}

function message(text) {
    const el = document.createElement("div")
    el.className = "empty"
    el.textContent = text
    return el
}

// --- subtitle picker -------------------------------------------------------

const subsModal = document.getElementById("subs-modal")
const subsTitle = document.getElementById("subs-title")
const subsTarget = document.getElementById("subs-target")
const subsCurrent = document.getElementById("subs-current")
const subListEl = document.getElementById("sub-list")
const subsTypeToggle = document.getElementById("subs-type-toggle")
const subsTitleInput = document.getElementById("subs-search-title")
const subsSeasonInput = document.getElementById("subs-search-season")
const subsSyncBtn = document.getElementById("subs-sync")
const subsSyncCount = document.getElementById("subs-sync-count")

function setSubsActiveType(type) {
    for (const btn of subsTypeToggle.querySelectorAll("button")) btn.classList.toggle("active", btn.dataset.type === type)
    subsSeasonInput.style.display = type === "tv" ? "" : "none"
}

function subsCurrentType() {
    return subsTypeToggle.querySelector("button.active")?.dataset.type || "movie"
}

// Launch a video in VLC via the server (which validates the path and spawns it).
async function playInVlc(entry) {
    try {
        await getJson("/api/play", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: entry.path })
        })
        status.textContent = `Launching VLC: ${entry.name}`
    } catch (err) {
        status.textContent = `error: ${err.message}`
    }
}

function openSubsPicker(entry) {
    state.subsPicker = entry
    state.subsWrote = false
    state.subsOverwriteOk = false
    state.subsCandidates = []
    state.subsAppliedFileId = null
    state.subsSync = new Map()
    subsTitle.textContent = `English subtitles — ${entry.name}`
    subsTarget.textContent = entry.path

    const has = entry.subKind && entry.subKind !== "none"
    subsCurrent.textContent = has
        ? entry.subKind === "embedded"
            ? "Currently: embedded subtitle track"
            : "Currently: subtitle sidecar present"
        : "Currently: no subtitles"
    subsCurrent.className = `subs-status ${has ? "has" : "none"}`

    subListEl.replaceChildren()
    subsModal.classList.remove("hidden")
    runSubsSearch() // initial search from server-inferred title/type/season
}

function closeSubsPicker() {
    subsModal.classList.add("hidden")
    state.subsPicker = null
    // Only now refresh the grid, so the item stays put while you audition
    // subtitles and only updates/leaves the filter once you're done.
    if (state.subsWrote) {
        state.subsWrote = false
        render()
    }
}

async function runSubsSearch(useInferred = true) {
    const entry = state.subsPicker
    if (!entry) return

    const params = new URLSearchParams({ path: entry.path })
    // After the first (inferred) search the form drives the query.
    if (!useInferred) {
        params.set("type", subsCurrentType())
        if (subsTitleInput.value.trim()) params.set("title", subsTitleInput.value.trim())
        if (subsCurrentType() === "tv" && subsSeasonInput.value !== "") params.set("season", subsSeasonInput.value)
    }

    subListEl.replaceChildren(message("Searching…"))
    try {
        const { body } = await getJson(`/api/subs/search?${params.toString()}`)
        if (useInferred && body.query) {
            setSubsActiveType(body.query.type)
            subsTitleInput.value = body.query.title || ""
            subsSeasonInput.value = body.query.season ?? ""
        }
        renderSubCandidates(body.candidates)
    } catch (err) {
        subListEl.replaceChildren(message(`error: ${err.message}`))
    }
}

function renderSubCandidates(candidates) {
    state.subsCandidates = candidates || []
    subListEl.replaceChildren()
    if (!candidates || candidates.length === 0) {
        subListEl.appendChild(message("No English subtitles found. Try editing the title or switching Movie/TV."))
        return
    }

    for (const cand of candidates) {
        const row = document.createElement("div")
        row.className = "sub-row"
        row.dataset.fileId = String(cand.fileId)

        const main = document.createElement("div")
        main.className = "sub-main"
        const name = document.createElement("div")
        name.className = "sub-name"
        name.textContent = cand.release
        main.appendChild(name)

        const tags = document.createElement("div")
        tags.className = "sub-tags"
        if (cand.hashMatch) tags.appendChild(subTag("hash match", "match"))
        if (cand.downloads) tags.appendChild(subTag(`${cand.downloads.toLocaleString()} downloads`))
        if (cand.rating) tags.appendChild(subTag(`★ ${cand.rating}`))
        if (cand.hi) tags.appendChild(subTag("HI"))
        if (cand.fps) tags.appendChild(subTag(`${cand.fps} fps`))
        main.appendChild(tags)
        row.appendChild(main)

        const btn = document.createElement("button")
        btn.className = "sub-pick"
        btn.textContent = "Use"
        btn.title = "Download as <basename>.srt"
        btn.addEventListener("click", () => applySubtitle(cand.fileId, btn))
        row.appendChild(btn)

        subListEl.appendChild(row)
        applySyncTag(row)
    }
}

function subTag(text, extra) {
    const el = document.createElement("span")
    el.className = `sub-tag${extra ? " " + extra : ""}`
    el.textContent = text
    return el
}

// Write a chosen subtitle to <basename>.srt without leaving the dialog, so the
// user can play it in VLC and try other candidates until satisfied. The first
// write may need overwrite confirmation (protecting a pre-existing sidecar);
// after that, swaps within this session overwrite silently.
async function applySubtitle(fileId, btn) {
    const entry = state.subsPicker
    if (!entry) return

    const restore = btn ? btn.textContent : null
    if (btn) {
        btn.disabled = true
        btn.textContent = "Saving…"
    }

    try {
        const { status: st, body } = await getJson("/api/subs/apply", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ targetPath: entry.path, fileId, overwrite: state.subsOverwriteOk })
        })

        if (st === 409 && body.needsConfirm) {
            if (btn) {
                btn.disabled = false
                btn.textContent = restore
            }
            if (!window.confirm(`Overwrite the existing subtitle?\n\n${body.existing}`)) return
            state.subsOverwriteOk = true
            return applySubtitle(fileId, btn)
        }

        state.subsWrote = true
        state.subsOverwriteOk = true
        state.subsAppliedFileId = String(fileId)
        // Offsets were relative to the previous file; drop them until re-checked.
        state.subsSync = new Map()
        for (const row of subListEl.querySelectorAll(".sub-row")) applySyncTag(row)
        const left = body.remaining != null ? ` · ${body.remaining} downloads left today` : ""
        subsCurrent.textContent = `Saved ${body.dest}${left} — check it in VLC, or pick another to replace it.`
        subsCurrent.className = "subs-status has"
        markApplied(btn)
    } catch (err) {
        if (btn) {
            btn.disabled = false
            btn.textContent = restore
        }
        subsCurrent.textContent = `error: ${err.message}`
        subsCurrent.className = "subs-status none"
    }
}

// Highlight the row whose subtitle is currently written; reset the others.
function markApplied(btn) {
    for (const b of subListEl.querySelectorAll(".sub-pick")) {
        b.disabled = false
        b.textContent = "Use"
        b.classList.remove("applied")
    }
    if (btn) {
        btn.textContent = "Saved ✓"
        btn.classList.add("applied")
    }
}

// --- sync check ---
// Compare the subtitle written on disk against the candidates listed around it,
// so an out-of-sync pick can be swapped for the one whose timing differs by the
// amount seen in VLC (VLC's own subtitle-delay readout, G/H keys, gives the
// number to look for). Each candidate row gets a tag with its offset.

// The `count` candidates nearest the saved one in the list (excluding it),
// sliding the window when the saved one is near an end; the top `count` when we
// don't know which candidate is on disk (a pre-existing sidecar).
function syncNeighbors(count) {
    const list = state.subsCandidates
    const idx = list.findIndex((c) => String(c.fileId) === state.subsAppliedFileId)
    if (idx < 0) return list.slice(0, count)
    const before = list.slice(0, idx)
    const after = list.slice(idx + 1)
    let nBefore = Math.min(before.length, Math.floor(count / 2))
    const nAfter = Math.min(after.length, count - nBefore)
    nBefore = Math.min(before.length, count - nAfter)
    return [...before.slice(before.length - nBefore), ...after.slice(0, nAfter)]
}

async function runSyncCheck() {
    const entry = state.subsPicker
    if (!entry) return

    const count = Math.max(1, Math.min(20, Number(subsSyncCount.value) || 8))
    const neighbors = syncNeighbors(count)
    if (neighbors.length === 0) {
        subsCurrent.textContent = "No other candidates to compare against."
        subsCurrent.className = "subs-status none"
        return
    }

    subsSyncBtn.disabled = true
    subsSyncBtn.textContent = "Checking…"
    subsCurrent.textContent = `Comparing ${neighbors.length} candidates against the saved subtitle…`
    subsCurrent.className = "subs-status"
    try {
        const { body } = await getJson("/api/subs/compare", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ targetPath: entry.path, fileIds: neighbors.map((c) => c.fileId) })
        })
        for (const r of body.results) state.subsSync.set(String(r.fileId), r)
        for (const row of subListEl.querySelectorAll(".sub-row")) applySyncTag(row)
        const left = body.remaining != null ? ` · ${body.remaining} downloads left today` : ""
        subsCurrent.textContent =
            `Compared ${body.results.length} against ${basename(body.reference.path)} — ` +
            `+ means that candidate's lines appear later than yours${left}`
        subsCurrent.className = "subs-status has"
    } catch (err) {
        subsCurrent.textContent = `error: ${err.message}`
        subsCurrent.className = "subs-status none"
    } finally {
        subsSyncBtn.disabled = false
        subsSyncBtn.textContent = "Sync check"
    }
}

// Set (or clear) a row's sync tag from state: the comparison result for its
// fileId, or "reference" for the saved candidate once any comparison exists.
function applySyncTag(row) {
    row.querySelector(".sub-tag.sync")?.remove()
    const fileId = row.dataset.fileId
    const result = state.subsSync.get(fileId)
    let tag = null
    if (result) tag = syncTag(result)
    else if (state.subsSync.size && fileId === state.subsAppliedFileId) tag = subTag("reference", "sync ref")
    if (tag) row.querySelector(".sub-tags").prepend(tag)
}

function syncTag(result) {
    const grade = result.confidence === "high" ? "good" : result.confidence === "low" ? "weak" : "none"
    let text
    if (result.kind === "offset") text = `sync ${fmtOffset(result.offset)}`
    else if (result.kind === "drift") text = `drift ${fmtOffset(result.start.offset)} → ${fmtOffset(result.end.offset)}`
    else if (result.kind === "error") text = "sync error"
    else if (result.kind === "inconsistent") text = "no consistent match"
    else text = "no match"

    const tag = subTag(text, `sync ${grade}`)
    if (result.kind === "error") {
        tag.title = result.error
    } else {
        const lines = [`${result.matched}/${result.samples.length} sampled lines found, ${result.agree} agree with the estimate`]
        if (result.kind === "drift")
            lines.push(`${fmtTime(result.start.at)} → ${fmtTime(result.end.at)} (likely a framerate mismatch)`)
        for (const s of result.samples) lines.push(`${fmtTime(s.at)}  ${s.offset == null ? "not found" : fmtOffset(s.offset)}`)
        tag.title = lines.join("\n")
    }
    return tag
}

function fmtOffset(seconds) {
    const r = Math.round(seconds * 100) / 100
    if (r === 0) return "±0.00s"
    return `${r > 0 ? "+" : "-"}${Math.abs(r).toFixed(2)}s`
}

function fmtTime(seconds) {
    const total = Math.round(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const ms = `${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`
    return h ? `${h}:${ms}` : ms
}

document.getElementById("subs-close").addEventListener("click", closeSubsPicker)
subsModal.addEventListener("click", (e) => {
    if (e.target === subsModal) closeSubsPicker()
})
document.getElementById("subs-search-go").addEventListener("click", () => runSubsSearch(false))
document.getElementById("subs-play").addEventListener("click", () => {
    if (state.subsPicker) playInVlc(state.subsPicker)
})
subsSyncBtn.addEventListener("click", runSyncCheck)
subsTitleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSubsSearch(false)
})
for (const btn of subsTypeToggle.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
        setSubsActiveType(btn.dataset.type)
        runSubsSearch(false)
    })
}

// --- bulk fix ---------------------------------------------------------------

const bulkModal = document.getElementById("bulk-modal")
const bulkText = document.getElementById("bulk-text")
const bulkFill = document.getElementById("bulk-fill")
const bulkClose = document.getElementById("bulk-close")

// Set a poster for every visible entry that is "missing" or "inherited" (never
// "direct"), using the top search result for each. Because those entries have no
// sidecar of their own, each write creates a new poster; if a destination
// somehow already exists the apply returns needsConfirm and we skip it rather
// than overwrite.
async function bulkFix() {
    const targets = (state.entries || []).filter((e) => e.posterKind === "missing" || e.posterKind === "fallback")
    if (targets.length === 0) {
        window.alert("Nothing to fix here — no missing or inherited posters are visible.")
        return
    }

    const ok = window.confirm(
        `Bulk Fix will set a poster for ${targets.length} item(s) — every visible "missing" or "inherited" entry — ` +
            `using the top search result for each.\n\nItems that already have their own poster are left untouched. Continue?`
    )
    if (!ok) return

    bulkText.textContent = `Starting… 0 / ${targets.length}`
    bulkFill.style.width = "0%"
    bulkClose.hidden = true
    bulkModal.classList.remove("hidden")

    let fixed = 0
    let skipped = 0
    let failed = 0

    for (let i = 0; i < targets.length; i++) {
        const entry = targets[i]
        bulkText.textContent = `Fixing ${i + 1} / ${targets.length}: ${entry.name}`
        bulkFill.style.width = `${Math.round((i / targets.length) * 100)}%`

        try {
            const params = new URLSearchParams({ path: entry.path, isDir: entry.type === "video" ? "0" : "1" })
            const { body } = await getJson(`/api/search?${params.toString()}`)
            const top = body.candidates?.[0]
            if (!top) {
                skipped++
                continue
            }
            const { status } = await getJson("/api/apply", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    targetPath: entry.path,
                    isDir: entry.type !== "video",
                    imageUrl: top.url,
                    overwrite: false
                })
            })
            if (status === 200) fixed++
            else skipped++ // 409 needsConfirm — leave existing poster alone
        } catch {
            failed++
        }
    }

    bulkFill.style.width = "100%"
    bulkText.textContent = `Done — ${fixed} set, ${skipped} skipped${failed ? `, ${failed} failed` : ""}.`
    bulkClose.hidden = false
    await render()
}

document.getElementById("bulk-btn").addEventListener("click", bulkFix)
bulkClose.addEventListener("click", () => bulkModal.classList.add("hidden"))

// --- events ----------------------------------------------------------------

// "Only missing" (posters) and "Needs subtitles" are separate flat views; turning
// one on clears the other so the grid always reflects a single filter.
missingToggle.addEventListener("change", () => {
    state.missingOnly = missingToggle.checked
    if (state.missingOnly && subsOnlyToggle) {
        state.subsOnly = false
        subsOnlyToggle.checked = false
    }
    render()
})

subsOnlyToggle.addEventListener("change", () => {
    state.subsOnly = subsOnlyToggle.checked
    if (state.subsOnly) {
        state.missingOnly = false
        missingToggle.checked = false
    }
    render()
})

hideDirsToggle.addEventListener("change", () => {
    state.hideDirs = hideDirsToggle.checked
    render()
})

for (const btn of sortToggle.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
        if (state.sort === btn.dataset.sort) return
        state.sort = btn.dataset.sort
        for (const b of sortToggle.querySelectorAll("button")) b.classList.toggle("active", b === btn)
        render()
    })
}

document.getElementById("modal-close").addEventListener("click", closePicker)
modal.addEventListener("click", (e) => {
    if (e.target === modal) closePicker()
})
document.getElementById("search-go").addEventListener("click", () => runSearch(false))
titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch(false)
})
for (const btn of typeToggle.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
        setActiveType(btn.dataset.type)
        runSearch(false)
    })
}

// Upload your own image for the open target.
const uploadInput = document.getElementById("upload-input")
document.getElementById("upload-btn").addEventListener("click", () => uploadInput.click())
uploadInput.addEventListener("change", () => {
    if (uploadInput.files[0]) uploadAndApply(uploadInput.files[0])
    uploadInput.value = ""
})

// --- settings ---------------------------------------------------------------

const settingsModal = document.getElementById("settings-modal")
const setTmdb = document.getElementById("set-tmdb")
const setFanart = document.getElementById("set-fanart")
const setOskey = document.getElementById("set-oskey")
const setOsuser = document.getElementById("set-osuser")
const setOspass = document.getElementById("set-ospass")
const setStatus = document.getElementById("set-status")

function markState(id, configured) {
    const el = document.getElementById(id)
    el.textContent = configured ? "✓ set" : "not set"
    el.className = `state ${configured ? "set" : "unset"}`
}

function clearSettingInputs() {
    setTmdb.value = ""
    setFanart.value = ""
    setOskey.value = ""
    setOsuser.value = ""
    setOspass.value = ""
}

function applySettingStates(body) {
    markState("state-tmdb", body.tmdb)
    markState("state-fanart", body.fanart)
    markState("state-oskey", body.osKey)
    markState("state-oslogin", body.osLogin)
}

async function openSettings() {
    setStatus.textContent = ""
    clearSettingInputs()
    try {
        const { body } = await getJson("/api/settings")
        applySettingStates(body)
    } catch {
        // leave states blank if unreachable
    }
    settingsModal.classList.remove("hidden")
}

async function saveSettings() {
    const payload = {}
    if (setTmdb.value.trim()) payload.tmdbKey = setTmdb.value.trim()
    if (setFanart.value.trim()) payload.fanartKey = setFanart.value.trim()
    if (setOskey.value.trim()) payload.osKey = setOskey.value.trim()
    if (setOsuser.value.trim()) payload.osUser = setOsuser.value.trim()
    if (setOspass.value.trim()) payload.osPass = setOspass.value.trim()
    setStatus.textContent = "Saving…"
    try {
        const { body } = await getJson("/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        })
        applySettingStates(body)
        clearSettingInputs()
        setStatus.textContent = "Saved."
    } catch (err) {
        setStatus.textContent = `error: ${err.message}`
    }
}

document.getElementById("settings-btn").addEventListener("click", openSettings)
document.getElementById("settings-close").addEventListener("click", () => settingsModal.classList.add("hidden"))
settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.classList.add("hidden")
})
document.getElementById("set-save").addEventListener("click", saveSettings)

// Learn whether the server enabled subtitle mode (--subs) before the first paint,
// so cards render their subtitle overlay and the filter shows up.
async function loadAppConfig() {
    try {
        const { body } = await getJson("/api/config")
        state.subsEnabled = Boolean(body.subs)
    } catch {
        state.subsEnabled = false
    }
    if (subsFilter) subsFilter.hidden = !state.subsEnabled

    // Cache library roots up front so a filtered view can render its breadcrumb
    // even when entered straight from a deep subdirectory.
    try {
        const { body } = await getJson("/api/libraries")
        state.libraries = body.map((l) => ({ path: l.path, name: l.name }))
    } catch {
        state.libraries = []
    }
}

loadAppConfig().then(render)
