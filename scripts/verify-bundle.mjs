let unhandledError

process.on("unhandledRejection", (error) => {
  unhandledError = error
})

const module = await import("../dist/index.js")
await new Promise((resolve) => setTimeout(resolve, 250))

if (!module.plugin) throw new Error("The bundled plugin export is missing")
if (unhandledError) throw unhandledError
