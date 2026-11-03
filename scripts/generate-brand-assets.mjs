// Regenerates every launcher icon, PWA icon and splash image from assets/brand/*.svg.
// Run after editing the brand SVGs: npm run build:brand-assets
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RES = path.join(ROOT, "android/app/src/main/res");
const IOS = path.join(ROOT, "ios/App/App/Assets.xcassets");

// Brand SVGs are 1024-unit adaptive-icon canvases (108dp). Launchers show the inner 72dp.
const CANVAS = 1024;
const VISIBLE = (CANVAS * 72) / 108;
const INSET = (CANVAS - VISIBLE) / 2;
const CORNER = 0.225;

const PAPER = "#F1F2F6";
const NIGHT = "#0A0F24";
const SHADOW = "#0B2ED8";

const DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASH_PORTRAIT = {
  ldpi: [240, 320],
  mdpi: [320, 480],
  hdpi: [480, 800],
  xhdpi: [720, 1280],
  xxhdpi: [960, 1600],
  xxxhdpi: [1280, 1920],
};

const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const [background, mark] = await Promise.all(
  ["pneuma-background.svg", "pneuma-mark.svg"].map(async (file) =>
    inner(await readFile(path.join(ROOT, "assets/brand", file), "utf8")),
  ),
);
const full = background + mark;

// Places the 1024-unit artwork so its crop square (whole canvas or the visible 72dp) lands on (x, y, side).
function placed(layers, x, y, side, crop) {
  const [offset, span] = crop === "visible" ? [INSET, VISIBLE] : [0, CANVAS];
  const scale = side / span;
  return `<g transform="translate(${x - offset * scale} ${y - offset * scale}) scale(${scale})">${layers}</g>`;
}

function shape(kind, x, y, side) {
  if (kind === "circle") return `<circle cx="${x + side / 2}" cy="${y + side / 2}" r="${side / 2}"/>`;
  return `<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${side * CORNER}"/>`;
}

function icon(size, { layers = full, crop = "visible", clip } = {}) {
  const art = placed(layers, 0, 0, size, crop);
  const content = clip
    ? `<defs><clipPath id="clip">${shape(clip, 0, 0, size)}</clipPath></defs><g clip-path="url(#clip)">${art}</g>`
    : art;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${content}</svg>`;
}

function splash(width, height, dark) {
  const side = Math.round(Math.min(width, height) * 0.28);
  const x = (width - side) / 2;
  const y = (height - side) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
<clipPath id="clip">${shape("squircle", x, y, side)}</clipPath>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${side * 0.06}"/></filter>
</defs>
<rect width="${width}" height="${height}" fill="${dark ? NIGHT : PAPER}"/>
<rect x="${x}" y="${y + side * 0.05}" width="${side}" height="${side}" rx="${side * CORNER}" fill="${SHADOW}" opacity="${dark ? 0.45 : 0.22}" filter="url(#soft)"/>
<g clip-path="url(#clip)">${placed(full, x, y, side, "visible")}</g>
</svg>`;
}

async function render(file, svg, { opaque = false } = {}) {
  let image = sharp(Buffer.from(svg));
  if (opaque) image = image.flatten({ background: PAPER }).removeAlpha();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await image.png({ compressionLevel: 9 }).toBuffer());
  return path.relative(ROOT, file);
}

const jobs = [];
const add = (file, svg, options) => jobs.push(() => render(file, svg, options));

for (const [density, factor] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  const launcher = Math.round(48 * factor);
  const layer = Math.round(108 * factor);
  add(path.join(dir, "ic_launcher.png"), icon(launcher, { clip: "squircle" }));
  add(path.join(dir, "ic_launcher_round.png"), icon(launcher, { clip: "circle" }));
  add(path.join(dir, "ic_launcher_foreground.png"), icon(layer, { layers: mark, crop: "full" }));
  add(path.join(dir, "ic_launcher_background.png"), icon(layer, { layers: background, crop: "full" }));

  const [w, h] = SPLASH_PORTRAIT[density];
  for (const dark of [false, true]) {
    const night = dark ? "-night" : "";
    add(path.join(RES, `drawable-port${night}-${density}`, "splash.png"), splash(w, h, dark));
    add(path.join(RES, `drawable-land${night}-${density}`, "splash.png"), splash(h, w, dark));
  }
}
add(path.join(RES, "drawable", "splash.png"), splash(320, 480, false));
add(path.join(RES, "drawable-night", "splash.png"), splash(320, 480, true));

add(path.join(ROOT, "public/icon-192.png"), icon(192, { clip: "squircle" }));
add(path.join(ROOT, "public/icon-512.png"), icon(512, { clip: "squircle" }));
add(path.join(ROOT, "public/icon-maskable-512.png"), icon(512, { crop: "full" }), { opaque: true });
add(path.join(ROOT, "public/apple-touch-icon.png"), icon(180), { opaque: true });

add(path.join(ROOT, "assets/icon-only.png"), icon(1024), { opaque: true });
add(path.join(ROOT, "assets/splash.png"), splash(2732, 2732, false));
add(path.join(ROOT, "assets/splash-dark.png"), splash(2732, 2732, true));

add(path.join(IOS, "AppIcon.appiconset/AppIcon-512@2x.png"), icon(1024), { opaque: true });
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  add(path.join(IOS, "Splash.imageset", name), splash(2732, 2732, false), { opaque: true });
}

const written = await Promise.all(jobs.map((job) => job()));
console.log(`Generated ${written.length} brand assets.`);
