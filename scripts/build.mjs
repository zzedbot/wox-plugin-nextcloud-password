import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const nccCli = require.resolve("@vercel/ncc/dist/ncc/cli.js")

await rm("dist", { recursive: true, force: true })
await mkdir("dist", { recursive: true })

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [nccCli, "build", "src/index.ts", "-o", "dist", "--minify"], {
    stdio: "inherit"
  })
  child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ncc exited with ${code}`))))
  child.once("error", reject)
})

const bundlePath = "dist/index.js"
const bundle = await readFile(bundlePath, "utf8")
const esmCompatibilityPrelude =
  'import { dirname as __woxDirname } from "node:path";import { fileURLToPath as __woxFileURLToPath } from "node:url";const __filename=__woxFileURLToPath(import.meta.url);const __dirname=__woxDirname(__filename);'
await writeFile(bundlePath, `${esmCompatibilityPrelude}${bundle}`)
await cp("plugin.json", "dist/plugin.json")
