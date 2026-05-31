#!/usr/bin/env node

import { scanLibraries } from "../src/scan.js"
import { resolvePoster } from "../src/resolve.js"
import { startServer } from "../src/server.js"

const USAGE = `posted - audit media libraries for missing posters

Usage:
  posted --library <dir> [--library <dir>...] [options]
  posted <dir>...                        positional paths are treated as libraries

Options:
  -l, --library <dir>   Add a library root (repeatable)
  -p, --port <n>        Port for the web UI (default: 8472)
  --open                Open the web UI in your browser on start
  --list                Print every video missing a poster, then exit
  -h, --help            Show this help
`

function parseArgs(argv) {
    const opts = { libraries: [], port: 8472, open: false, list: false, help: false }

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "-l":
            case "--library":
                opts.libraries.push(argv[++i])
                break
            case "-p":
            case "--port":
                opts.port = Number(argv[++i])
                break
            case "--open":
                opts.open = true
                break
            case "--list":
                opts.list = true
                break
            case "-h":
            case "--help":
                opts.help = true
                break
            default:
                if (a.startsWith("-")) {
                    process.stderr.write(`posted: unknown option ${a}\n`)
                    opts.help = true
                } else {
                    opts.libraries.push(a)
                }
        }
    }

    return opts
}

function printMissing(index) {
    let missing = 0
    for (const video of index.videos) {
        if (resolvePoster(video, index.images).kind === "missing") {
            process.stdout.write(video.path + "\n")
            missing++
        }
    }
    process.stderr.write(`\n${missing} of ${index.videos.length} videos missing a poster\n`)
}

async function main() {
    const opts = parseArgs(process.argv.slice(2))

    if (opts.help || opts.libraries.length === 0) {
        process.stdout.write(USAGE)
        return
    }

    const index = await scanLibraries(opts.libraries)

    if (opts.list) {
        printMissing(index)
        return
    }

    await startServer(index, { port: opts.port, open: opts.open })
}

main()
