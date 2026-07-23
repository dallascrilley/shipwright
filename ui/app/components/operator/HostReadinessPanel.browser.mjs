import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, "../../..");

function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_PKG && existsSync(process.env.PLAYWRIGHT_PKG)) {
    return process.env.PLAYWRIGHT_PKG;
  }
  try {
    return dirname(require.resolve("playwright/package.json"));
  } catch {
    // fall through
  }
  // Prefer mise package path when playwright is installed as npm-playwright.
  const mise = spawnSync("bash", ["-lc", "mise where npm-playwright"], {
    encoding: "utf8",
  });
  if (mise.status === 0 && mise.stdout.trim()) {
    const candidate = join(
      mise.stdout.trim(),
      "lib",
      "node_modules",
      "playwright",
    );
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  const home = process.env.HOME;
  if (home) {
    const candidate = join(
      home,
      ".local/share/mise/installs/npm-playwright/latest/lib/node_modules/playwright",
    );
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

const playwrightPkg = resolvePlaywright();
if (!playwrightPkg) {
  console.log("BROWSER_PROOF_SKIPPED: playwright not resolvable");
  process.exit(0);
}

const { chromium } = await import(
  pathToFileURL(join(playwrightPkg, "index.mjs")).href
);
const esbuild = require(require.resolve("esbuild", { paths: [uiRoot] }));

const outdir = mkdtempSync(join(tmpdir(), "host-ready-browser-"));
const outfile = join(outdir, "harness.js");
let server;
let browser;

try {
  await esbuild.build({
    entryPoints: [join(__dirname, "host-readiness-panel.browser-harness.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile,
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    logLevel: "silent",
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>readiness harness</title></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

  server = createServer((req, res) => {
    if (req.url === "/harness.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(readFileSync(outfile));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let launched = false;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    });
    launched = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      console.log(
        "BROWSER_PROOF_SKIPPED: no browser executable (" +
          message.split("\n")[0] +
          ")",
      );
    } else {
      throw err;
    }
  }

  if (launched) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

    const body = await page.textContent("body");
    if (!body.includes("Host readiness"))
      throw new Error("panel did not render");
    if (!body.includes("Demo mode")) throw new Error("demo copy missing");
    if (!body.includes("provider")) throw new Error("provider chip missing");

    const before = await page.textContent('[data-testid="refresh-count"]');
    if (before !== "0")
      throw new Error(`expected refresh count 0, got ${before}`);

    await page.getByRole("button", { name: "Refresh" }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="refresh-count"]');
      return el && el.textContent === "1";
    });

    const after = await page.textContent('[data-testid="refresh-count"]');
    if (after !== "1") throw new Error("refresh did not increment");

    console.log("BROWSER_PROOF_OK");
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(outdir, { recursive: true, force: true });
}
