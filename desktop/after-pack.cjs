// electron-builder leaves node_modules out of extraResources, and the
// standalone server is nothing without its traced node_modules. So the
// standalone build is copied whole, after packing, into the app's Resources:
// server.js and its modules, the static chunks, and the public folder.
const fs = require("fs");
const path = require("path");

module.exports = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resources = path.join(context.appOutDir, appName, "Contents", "Resources");
  const target = path.join(resources, "standalone");
  const root = context.packager.projectDir;
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, ".next", "standalone"), target, { recursive: true, dereference: true });
  fs.cpSync(path.join(root, ".next", "static"), path.join(target, ".next", "static"), { recursive: true });
  fs.cpSync(path.join(root, "public"), path.join(target, "public"), { recursive: true });
};
