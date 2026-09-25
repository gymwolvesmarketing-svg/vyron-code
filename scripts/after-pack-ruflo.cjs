/**
 * electron-builder afterPack hook: copies the prebuilt Ruflo runtime (build/ruflo-runtime, see
 * scripts/build-ruflo-runtime.mjs) into the packaged app's resources folder as real files.
 *
 * electron-builder's own extraResources copy drops every `node_modules` folder, which would leave the runtime
 * without its dependencies, so the copy is done here with plain fs. Build-time only.
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, "build", "ruflo-runtime");
  const target = path.join(context.appOutDir, "resources", "ruflo-runtime");
  if (!fs.existsSync(path.join(source, "node.exe")) || !fs.existsSync(path.join(source, "node_modules", "ruflo", "bin", "ruflo.js"))) {
    throw new Error("Ruflo runtime is missing: run `npm run runtime:ruflo` first");
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  console.log("  • ruflo runtime copied to " + path.relative(context.appOutDir, target));
};
