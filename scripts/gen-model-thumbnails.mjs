// 预生成筑境素材库缩略图：用无头 Chromium(SwiftShader 软件 WebGL)离线渲染每个
// 预设 .glb 模型，输出小尺寸 webp 到 public/models/_thumbs/。
// 渲染参数(相机/打光/背景)与运行时 thumbnail-generator.ts 的 getThumbnail 保持一致。
//
// 跑法（puppeteer 不在依赖里，避免 Netlify 构建时下载 Chromium，需先临时安装）：
//   npm i -D puppeteer && node scripts/gen-model-thumbnails.mjs && npm remove puppeteer
// 新增/修改预设模型后重跑本脚本，再提交 public/models/_thumbs/ 即可。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THUMB_DIR = path.join(ROOT, "public/models/_thumbs");
const RENDER_PX = 160; // 2x of 80px display

// ── 与 ModelPalette 一致的缩略图路径推导 ──
const presetThumbName = (url) =>
  url.replace(/^\/models\//, "").replace(/\.glb$/i, "").replace(/\//g, "__") + ".webp";

// ── 从 scene-store.ts 抽取预设 .glb url ──
function readPresetGlbUrls() {
  const t = fs.readFileSync(path.join(ROOT, "components/world-builder/scene-store.ts"), "utf-8");
  return [...t.matchAll(/url:\s*"(\/models\/[^"]+\.glb)"/g)].map((m) => m[1]);
}

const MIME = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".glb": "model/gltf-binary", ".bin": "application/octet-stream",
  ".html": "text/html", ".wasm": "application/wasm",
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/__render.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(PAGE_HTML); return;
      }
      const filePath = path.join(ROOT, urlPath);
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(${RENDER_PX}, ${RENDER_PX});
renderer.setClearColor(0x2a2520, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 2;

window.__render = (modelUrl) => new Promise((resolve, reject) => {
  const loader = new GLTFLoader();
  loader.load(modelUrl, (gltf) => {
    try {
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(1, 2, 3); scene.add(dir);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
      const object = gltf.scene;
      scene.add(object);
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      object.position.sub(center);
      camera.position.set(size * 0.7, size * 0.5, size * 1.1);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      resolve(renderer.domElement.toDataURL('image/png'));
    } catch (e) { reject(String(e)); }
  }, undefined, (e) => reject('load fail: ' + String(e)));
});
window.__ready = true;
</script></body></html>`;

(async () => {
  const urls = readPresetGlbUrls();
  console.log(`预设模型 ${urls.length} 个，开始渲染...`);
  fs.mkdirSync(THUMB_DIR, { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
           "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(`${base}/__render.html`, { waitUntil: "load" });
  await page.waitForFunction("window.__ready === true", { timeout: 30000 });

  let ok = 0, fail = 0, totalBytes = 0;
  for (const url of urls) {
    const httpUrl = `${base}/public${url}`;
    try {
      const dataUrl = await page.evaluate((u) => globalThis.__render(u), httpUrl);
      const png = Buffer.from(dataUrl.split(",")[1], "base64");
      const out = path.join(THUMB_DIR, presetThumbName(url));
      await sharp(png).webp({ quality: 82 }).toFile(out);
      const sz = fs.statSync(out).size; totalBytes += sz; ok++;
      console.log(`  ✓ ${(sz / 1024).toFixed(0)}KB  ${presetThumbName(url)}`);
    } catch (e) {
      fail++; console.error(`  ✗ ${url}  ${e}`);
    }
  }
  await browser.close();
  server.close();
  console.log(`\n完成：成功 ${ok}，失败 ${fail}，缩略图合计 ${(totalBytes / 1024).toFixed(0)}KB`);
  if (fail) process.exit(1);
})();
