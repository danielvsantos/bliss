import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

// Direct navigation (reload, bookmark, shared link) to a route whose first
// segment matches a directory in the built dist/ makes the static server
// resolve that directory instead of falling back to index.html (nginx 403 on
// /assets, #87). Parse the sources as text so the test doesn't import every page.
const webRoot = path.resolve(__dirname, "..");

const routePaths = [
  ...readFileSync(path.join(webRoot, "src/routes.tsx"), "utf8").matchAll(/path:\s*"([^"]+)"/g),
].map((m) => m[1]);

const topSegment = (p: string) => p.split("/")[1];

describe("route paths vs static build output", () => {
  it("finds the route table", () => {
    expect(routePaths).toContain("/assets");
  });

  it("no route reuses Vite's build assetsDir", () => {
    const viteConfig = readFileSync(path.join(webRoot, "vite.config.ts"), "utf8");
    const assetsDir = viteConfig.match(/assetsDir:\s*'([^']+)'/)?.[1];
    expect(assetsDir).toBeDefined();
    expect(routePaths.map(topSegment)).not.toContain(assetsDir);
  });

  it("no route reuses a top-level public/ directory", () => {
    const publicDirs = readdirSync(path.join(webRoot, "public"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const segments = routePaths.map(topSegment);
    for (const dir of publicDirs) expect(segments).not.toContain(dir);
  });
});
