import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";
const nodeBuiltins = builtinModules.flatMap((name) =>
  name.startsWith("node:") ? [name] : [name, `node:${name}`]
);

const context = await esbuild.context({
  banner: { js: "/* Vault Sync */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...nodeBuiltins
  ],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  process.exit(0);
}

await context.watch();
