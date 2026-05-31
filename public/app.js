// posted — gallery + poster picker (milestone 3).
// Browse libraries, filter to missing posters, and click an item to search TMDB
// and write a chosen poster (with overwrite confirmation).

const grid = document.getElementById("grid")
const breadcrumb = document.getElementById("breadcrumb")
const status = document.getElementById("status")
const missingToggle = document.getElementById("missing-only")

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
    picker: null // the entry currently open in the modal
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

function renderGrid(entries) {
    state.entries = entries // remembered so Bulk Fix can act on what's visible
    grid.replaceChildren()
    for (const entry of entries) grid.appendChild(makeCard(entry))
}

async function navigate(targetPath) {
    state.path = targetPath
    await render()
}

async function render() {
    try {
        if (state.missingOnly) {
            breadcrumb.style.visibility = "hidden"
            const { body } = await getJson("/api/missing")
            renderGrid(body)
            status.textContent = `${body.length} videos missing a poster`
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
        status.textContent = `${body.entries.length - videos} folders, ${videos} videos`
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

missingToggle.addEventListener("change", () => {
    state.missingOnly = missingToggle.checked
    render()
})

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
const setStatus = document.getElementById("set-status")

function markState(id, configured) {
    const el = document.getElementById(id)
    el.textContent = configured ? "✓ set" : "not set"
    el.className = `state ${configured ? "set" : "unset"}`
}

async function openSettings() {
    setStatus.textContent = ""
    setTmdb.value = ""
    setFanart.value = ""
    try {
        const { body } = await getJson("/api/settings")
        markState("state-tmdb", body.tmdb)
        markState("state-fanart", body.fanart)
    } catch {
        // leave states blank if unreachable
    }
    settingsModal.classList.remove("hidden")
}

async function saveSettings() {
    const payload = {}
    if (setTmdb.value.trim()) payload.tmdbKey = setTmdb.value.trim()
    if (setFanart.value.trim()) payload.fanartKey = setFanart.value.trim()
    setStatus.textContent = "Saving…"
    try {
        const { body } = await getJson("/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        })
        markState("state-tmdb", body.tmdb)
        markState("state-fanart", body.fanart)
        setTmdb.value = ""
        setFanart.value = ""
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

render()
