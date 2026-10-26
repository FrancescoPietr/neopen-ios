// Metro (the bundler of the app). One addition to Expo's defaults:
// the Obsidian plugin's engine (plugin/src) also runs in the app, so its `import … from "obsidian"` points to the
// phone's version of that API (plugin/src/phone/obsidian.ts), and its other packages come from the app's node_modules
// (not from plugin/node_modules, which only exists where the plugin itself is built).
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const obsidianShim = path.resolve(__dirname, "plugin/src/phone/obsidian.ts");
const pluginSrc = path.resolve(__dirname, "plugin/src") + path.sep;
const appEntry = path.resolve(__dirname, "index.ts");
const bare = (name) => !name.startsWith(".") && !path.isAbsolute(name);

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "obsidian") return { type: "sourceFile", filePath: obsidianShim };
  const resolve = upstream ?? context.resolveRequest;
  if (bare(moduleName) && context.originModulePath.startsWith(pluginSrc)) {
    return resolve({ ...context, originModulePath: appEntry }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
