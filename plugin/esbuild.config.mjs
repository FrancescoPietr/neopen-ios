import esbuild from "esbuild";
import builtins from "builtin-modules";
import path from "node:path";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@electron/remote", "@codemirror/*", "@lezer/*", ...builtins.filter((m) => m !== "zlib")],
  alias: { zlib: path.resolve("src/shims/zlib.ts") },
  format: "cjs",
  target: "es2020",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "dist/main.js",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
