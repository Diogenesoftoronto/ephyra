/** Transparent, reproducible exports of the real texture shader. No provider calls. Requires ffmpeg in PATH. */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const output = join(root, "public/motion");
const temp = await mkdtemp(join(tmpdir(), "ephyra-jelly-export-"));
const browser = await launch();
const server = serve(temp);
const fps = 20;
const frames = 42;
try {
  const bundle = await Bun.build({
    entrypoints: [join(root, "src/lib/jelly-shader.ts")],
    target: "browser",
    format: "esm",
  });
  if (!bundle.success) throw new Error("Shader bundle failed");
  await writeFile(join(temp, "shader.js"), await bundle.outputs[0]!.text());
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><html><body style="margin:0;background:transparent">
    <canvas width="256" height="256"></canvas><script type="module">
    import {createJellyRenderer} from './shader.js';
    const image = new Image(); image.src = '/art.webp'; await image.decode();
    const canvas = document.querySelector('canvas'); const renderer = createJellyRenderer(canvas, image);
    if (!renderer) throw new Error('WebGL is required to export the actual shader');
    window.frame = (time) => { renderer.render(time, 1); return canvas.toDataURL('image/png').split(',')[1]; };
    </script></body></html>`,
  );
  await mkdir(output, { recursive: true });
  for (const [name, source] of [
    ["ephyra-specimen-v1", "motion/ephyra-specimen-v1.webp"],
    ["velum-refraction-v1", "personas/velum.webp"],
  ]) {
    await copyFile(join(root, "public", source!), join(temp, "art.webp"));
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    await page.goto(server.url);
    await page.waitForFunction(() => typeof (window as any).frame === "function");
    for (let i = 0; i < frames; i++) {
      const base64 = await page.evaluate((t) => (window as any).frame(t) as string, i / frames);
      await writeFile(join(temp, `frame-${String(i).padStart(3, "0")}.png`), Buffer.from(base64, "base64"));
    }
    await page.close();
    const encode = async (args: string[]) => {
      const command = Bun.spawn(["rtk", "proxy", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const error = await new Response(command.stderr).text();
      if ((await command.exited) !== 0) throw new Error(error);
    };
    const input = ["-framerate", String(fps), "-i", join(temp, "frame-%03d.png")];
    await encode([
      ...input,
      "-vf",
      "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=80",
      "-loop",
      "0",
      join(output, `${name}.gif`),
    ]);
    await encode([...input, "-c:v", "libwebp_anim", "-quality", "82", "-loop", "0", join(output, `${name}-loop.webp`)]);
    console.log(`${name}: ${frames} transparent frames, ${fps}fps, 256px, GIF + animated WebP`);
  }
} finally {
  await browser.close();
  server.stop();
  await rm(temp, { recursive: true, force: true });
}
