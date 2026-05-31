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
        renderCandidates(body.candidates)
    } catch (err) {
        candidatesEl.replaceChildren(message(`error: ${err.message}`))
    }
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
        el.appendChild(box)

        const meta = document.createElement("div")
        meta.className = "meta"
        const dims = cand.width && cand.height ? `${cand.width}×${cand.height}` : ""
        meta.textContent = [cand.label, dims].filter(Boolean).join(" · ")
        el.appendChild(meta)

        el.addEventListener("click", () => applyPoster(cand))
        candidatesEl.appendChild(el)
    }
}

async function applyPoster(cand, overwrite = false) {
    const entry = state.picker
    if (!entry) return

    const payload = {
        targetPath: entry.path,
        isDir: entry.type !== "video",
        imageUrl: cand.url,
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
                return applyPoster(cand, true)
            }
            return
        }

        closePicker()
        await render()
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

render()
