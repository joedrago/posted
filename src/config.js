import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const CONFIG_DIR = path.join(os.homedir(), ".config", "posted")
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")

// Recognized secret fields. Settings writes are restricted to these keys and to
// the fixed CONFIG_FILE path — request input never influences the destination.
const FIELDS = ["tmdbKey", "fanartKey"]

export function loadConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    } catch {
        return {}
    }
}

// Merge the given fields over the saved config and persist. Keys are secrets, so
// the file is written user-only (0600).
export function saveConfig(partial) {
    const next = { ...loadConfig() }
    for (const field of FIELDS) {
        if (!(field in partial)) continue
        if (partial[field]) next[field] = partial[field]
        else delete next[field]
    }
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
    return next
}
