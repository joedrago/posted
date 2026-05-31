// posted — read-only gallery (milestone 2).
// Browse libraries as a folder grid; toggle "Only missing" for a flat list of
// every video with no resolvable poster. Choosing posters arrives in M3.

const grid = document.getElementById("grid")
const breadcrumb = document.getElementById("breadcrumb")
const status = document.getElementById("status")
const missingToggle = document.getElementById("missing-only")

const state = {
    path: null, // current directory when browsing; null = library list
    missingOnly: false
}

async function getJson(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
    return res.json()
}

function posterUrl(entry) {
    return entry.posterKind === "missing" ? null : `/api/poster?path=${encodeURIComponent(entry.poster)}`
}

function basename(p) {
    return p.split("/").filter(Boolean).pop() || p
}

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
    badge.textContent = entry.posterKind === "fallback" ? `inherited` : entry.posterKind === "direct" ? "poster" : "missing"
    if (entry.posterKind === "fallback" && entry.viaDir) badge.title = `inherited from ${basename(entry.viaDir)}`
    poster.appendChild(badge)

    if (entry.type !== "video") {
        const icon = document.createElement("span")
        icon.className = "folder-icon"
        icon.textContent = "▸"
        poster.appendChild(icon)
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

    if (entry.type !== "video") {
        card.addEventListener("click", () => navigate(entry.path))
    }

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
            renderBreadcrumb(null)
            breadcrumb.style.visibility = "hidden"
            const missing = await getJson("/api/missing")
            renderGrid(missing)
            status.textContent = `${missing.length} videos missing a poster`
            return
        }

        breadcrumb.style.visibility = "visible"

        if (state.path === null) {
            renderBreadcrumb(null)
            const libs = await getJson("/api/libraries")
            renderGrid(libs)
            status.textContent = `${libs.length} libraries`
            return
        }

        const data = await getJson(`/api/tree?path=${encodeURIComponent(state.path)}`)
        renderBreadcrumb(data.breadcrumb)
        renderGrid(data.entries)
        const videos = data.entries.filter((e) => e.type === "video").length
        const dirs = data.entries.length - videos
        status.textContent = `${dirs} folders, ${videos} videos`
    } catch (err) {
        status.textContent = `error: ${err.message}`
    }
}

missingToggle.addEventListener("change", () => {
    state.missingOnly = missingToggle.checked
    render()
})

render()
