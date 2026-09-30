const esbuild = require("esbuild");
const fs = require("node:fs/promises");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const extensionBuild = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
};

const webviewBuild = {
  ...common,
  entryPoints: ["webview/main.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  target: "es2022",
  format: "iife",
  jsx: "automatic",
  loader: { ".css": "css" },
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
};

async function copyWorker() {
  await fs.mkdir("dist", { recursive: true });
  await fs.copyFile(
    path.join("node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"),
    path.join("dist", "pdf.worker.min.mjs"),
  );
}

async function main() {
  if (watch) {
    const [extension, webview] = await Promise.all([
      esbuild.context(extensionBuild),
      esbuild.context(webviewBuild),
    ]);
    await copyWorker();
    await Promise.all([extension.watch(), webview.watch()]);
    console.log("[ai-editor] watching…");
    return;
  }
  await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
  await copyWorker();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
