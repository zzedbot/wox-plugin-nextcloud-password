import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { nodeZip } = require("bestzip")

await nodeZip({
  cwd: "dist",
  destination: "../wox.plugin.NextcloudPasswords.wox",
  level: 9,
  source: "*"
})
