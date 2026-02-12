/**
 * Build script: bundles inject.ts into a single IIFE JS file
 * that the proxy server can inject into HTML pages.
 */
const esbuild = require("esbuild")
const path = require("path")

esbuild
  .build({
    entryPoints: [path.join(__dirname, "..", "src", "inject", "inject.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2018"],
    outfile: path.join(__dirname, "..", "dist-inject", "inject.js"),
  })
  .then(() => {
    console.log("✅ inject.ts bundled to dist-inject/inject.js")
  })
  .catch((err) => {
    console.error("❌ Build failed:", err)
    process.exit(1)
  })
