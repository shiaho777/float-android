// map-engine.ts — Pure TypeScript map generation engine
// Zero external dependencies. Seeded PRNG for reproducible output.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MapRegionInput = {
  id: string;
  l1_name_cn: string;
  l1_name_en: string;
  geography: "mountainous" | "plains" | "canyon";
  river_count: number;
  adjacent_to: string[];
  l2_nodes: string[];
  l3_nodes: string[];
  sub_zones?: string[];
};

export type MapGenerationInput = {
  map_settings: { header: string; title: string };
  regions: MapRegionInput[];
  seed?: number;
};

export type GeoJSONFeature = {
  geometry: {
    type: string;
    coordinates: number[][][] | number[][][][];
  } | null;
  properties?: Record<string, unknown>;
};

export type GeoJSONData = {
  features: GeoJSONFeature[];
};

export type MapGenerationOutput = {
  gridWidth: number;
  gridHeight: number;
  scale: number;

  regionPaths: { id: string; path: string; color: string }[];
  outerContourPath: string;

  contourPath: string;
  topoRects: { x: number; y: number; w: number; h: number; alpha: number }[];

  rivers: { path: string; width: number }[];
  lakes: { path: string }[];

  subBorders: { path: string }[];
  subLabels: { x: number; y: number; name: string }[];

  trunkRoutes: { path: string }[];
  branchL2Routes: { path: string }[];
  branchL3Routes: { path: string }[];

  l1Nodes: { id: string; x: number; y: number; nameCn: string; nameEn: string }[];
  l2Nodes: { x: number; y: number; name: string; regionIdx: number }[];
  l3Nodes: { x: number; y: number; name: string; regionIdx: number }[];

  edges: [string, string][];  // node ID pairs connected by routes

  header: string;
  title: string;
};

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32
// ---------------------------------------------------------------------------

class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
    if (this.state === 0) this.state = 1;
  }

  /** Returns a float in [0, 1) */
  random(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [lo, hi] inclusive */
  randint(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo + 1));
  }

  /** Returns a float in [lo, hi) */
  uniform(lo: number, hi: number): number {
    return lo + this.random() * (hi - lo);
  }

  /** Pick a random element from an array */
  choice<T>(arr: T[]): T {
    return arr[Math.floor(this.random() * arr.length)];
  }

  /** Pick k unique random elements (Fisher-Yates partial shuffle) */
  sample<T>(arr: T[], k: number): T[] {
    const copy = arr.slice();
    const n = copy.length;
    const result: T[] = [];
    for (let i = 0; i < k && i < n; i++) {
      const j = i + Math.floor(this.random() * (n - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
      result.push(copy[i]);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// MinHeap — replaces Python heapq
// ---------------------------------------------------------------------------

class MinHeap<T> {
  private data: T[] = [];
  private cmp: (a: T, b: T) => number;

  constructor(cmp: (a: T, b: T) => number) {
    this.cmp = cmp;
  }

  get size(): number {
    return this.data.length;
  }

  push(val: T): void {
    this.data.push(val);
    this._bubbleUp(this.data.length - 1);
  }

  pop(): T {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.data[i], this.data[p]) < 0) {
        [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
        i = p;
      } else break;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.cmp(this.data[l], this.data[smallest]) < 0) smallest = l;
      if (r < n && this.cmp(this.data[r], this.data[smallest]) < 0) smallest = r;
      if (smallest !== i) {
        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
        i = smallest;
      } else break;
    }
  }
}

// Comparator for [cost, ...rest] tuples (compare first element)
function cmpFirst(a: number[], b: number[]): number {
  return a[0] - b[0];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make2d<T>(w: number, h: number, fill: T): T[][] {
  const arr: T[][] = [];
  for (let x = 0; x < w; x++) {
    arr[x] = [];
    for (let y = 0; y < h; y++) arr[x][y] = fill;
  }
  return arr;
}

function hypot(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  const n = poly.length;
  let inside = false;
  let [p1x, p1y] = poly[0];
  for (let i = 1; i <= n; i++) {
    const [p2x, p2y] = poly[i % n];
    if (Math.min(p1y, p2y) < y && y <= Math.max(p1y, p2y)) {
      if (x <= Math.max(p1x, p2x)) {
        let xinters = p1x;
        if (p1y !== p2y) {
          xinters = ((y - p1y) * (p2x - p1x)) / (p2y - p1y) + p1x;
        }
        if (p1x === p2x || x <= xinters) inside = !inside;
      }
    }
    p1x = p2x;
    p1y = p2y;
  }
  return inside;
}

function smoothPath(path: [number, number][], iters: number = 2): [number, number][] {
  if (path.length < 3) return path;
  let p = path;
  for (let it = 0; it < iters; it++) {
    const np: [number, number][] = [p[0]];
    for (let i = 1; i < p.length; i++) {
      const p0 = p[i - 1];
      const p1 = p[i];
      np.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      np.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    np.push(p[p.length - 1]);
    p = np;
  }
  return p;
}

function smoothPolygon(poly: [number, number][], iters: number = 3): [number, number][] {
  if (poly.length < 3) return poly;
  let p = poly.slice();
  // Remove closing duplicate
  if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) {
    p = p.slice(0, -1);
  }
  for (let it = 0; it < iters; it++) {
    const np: [number, number][] = [];
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const p0 = p[i];
      const p1 = p[(i + 1) % n];
      np.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      np.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    p = np;
  }
  p.push(p[0]);
  return p;
}

/** Encode a coordinate key for Set/Map usage */
function ck(x: number, y: number): string {
  return `${x},${y}`;
}

/** Encode a segment key (pair of points) */
function sk(x1: number, y1: number, x2: number, y2: number): string {
  return `${x1},${y1}|${x2},${y2}`;
}

function pathToD(points: [number, number][], scale: number, close: boolean = false): string {
  if (points.length === 0) return "";
  let d = `M ${points[0][0] * scale} ${points[0][1] * scale}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0] * scale} ${points[i][1] * scale}`;
  }
  if (close) d += " Z";
  return d;
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

const W = 120;
const H = 90;
const SCALE = 10;

const PASTEL_COLORS = [
  "#f8bca8",
  "#fce5a9",
  "#c8e7ca",
  "#b2dfdc",
  "#d1c4e8",
  "#f8bbd0",
  "#ffccbc",
  "#d9e2b3",
];

const DIR4: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
const DIR8: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

export function generateMap(
  input: MapGenerationInput,
  geoData: GeoJSONData,
): MapGenerationOutput {
  const rng = new PRNG(input.seed ?? Date.now());

  const regionsData = input.regions;
  const N = Math.max(1, regionsData.length);

  const grid = make2d<number>(W, H, -1);

  // =========================================================================
  // 1. GeoJSON polygon extraction
  // =========================================================================

  const polygons: [number, number][][] = [];
  for (const feature of geoData.features) {
    const geom = feature.geometry;
    if (!geom) continue;
    if (geom.type === "Polygon") {
      const coords = geom.coordinates as number[][][];
      if (coords[0].length > 20) {
        polygons.push(coords[0].map((c) => [c[0], c[1]] as [number, number]));
      }
    } else if (geom.type === "MultiPolygon") {
      const multi = geom.coordinates as number[][][][];
      for (const poly of multi) {
        if (poly[0].length > 20) {
          polygons.push(poly[0].map((c) => [c[0], c[1]] as [number, number]));
        }
      }
    }
  }

  const selectedPolys = rng.sample(polygons, rng.randint(3, 6));

  // =========================================================================
  // 2. Transform polygons
  // =========================================================================

  let transformedPolys: [number, number][][] = [];
  for (const p of selectedPolys) {
    const xs = p.map((pt) => pt[0]);
    const ys = p.map((pt) => pt[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const h = maxY - minY;
    if (w === 0 || h === 0) continue;

    const scaleW = rng.uniform(30, 70) / w;
    const scaleH = rng.uniform(30, 70) / h;
    const flipX = rng.choice([-1, 1]);
    const flipY = rng.choice([-1, 1]);
    const angle = rng.uniform(0, 2 * Math.PI);
    const cx = rng.uniform(W / 2 - 20, W / 2 + 20);
    const cy = rng.uniform(H / 2 - 15, H / 2 + 15);

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const tPoly: [number, number][] = [];
    for (const pt of p) {
      const nx = (pt[0] - minX - w / 2) * scaleW * flipX;
      const ny = (pt[1] - minY - h / 2) * scaleH * flipY;
      const rx = nx * cosA - ny * sinA;
      const ry = nx * sinA + ny * cosA;
      tPoly.push([rx + cx, ry + cy]);
    }
    transformedPolys.push(tPoly);
  }

  // Fit within grid bounds
  const allPts = transformedPolys.flat();
  if (allPts.length > 0) {
    const minTx = Math.min(...allPts.map((p) => p[0]));
    const maxTx = Math.max(...allPts.map((p) => p[0]));
    const minTy = Math.min(...allPts.map((p) => p[1]));
    const maxTy = Math.max(...allPts.map((p) => p[1]));
    const bbW = maxTx - minTx;
    const bbH = maxTy - minTy;

    const safeW = W - 20;
    const safeH = H - 20;
    let sf = bbW > 0 && bbH > 0 ? Math.min(safeW / bbW, safeH / bbH) : 1.0;
    if (sf > 1.0) sf = 1.0;

    const shiftX = (W - bbW * sf) / 2 - minTx * sf;
    const shiftY = (H - bbH * sf) / 2 - minTy * sf;

    transformedPolys = transformedPolys.map((poly) =>
      poly.map((pt) => [pt[0] * sf + shiftX, pt[1] * sf + shiftY] as [number, number]),
    );
  }

  // =========================================================================
  // 3. Rasterize land mask + blur
  // =========================================================================

  // Precompute bounding boxes
  const bboxes = transformedPolys.map((p) => {
    const xs = p.map((pt) => pt[0]);
    const ys = p.map((pt) => pt[1]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] as [
      number,
      number,
      number,
      number,
    ];
  });

  let landWeight = make2d<number>(W, H, 0.0);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      for (let pi = 0; pi < transformedPolys.length; pi++) {
        const bb = bboxes[pi];
        if (bb[0] <= x && x <= bb[1] && bb[2] <= y && y <= bb[3]) {
          if (pointInPolygon(x, y, transformedPolys[pi])) {
            landWeight[x][y] = 1.0;
            break;
          }
        }
      }
    }
  }

  // 3x iterative blur
  for (let iter = 0; iter < 3; iter++) {
    const newW = make2d<number>(W, H, 0.0);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let v = 0;
        let c = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              v += landWeight[nx][ny];
              c++;
            }
          }
        }
        newW[x][y] = v / c;
      }
    }
    landWeight = newW;
  }

  // =========================================================================
  // 4. Collect land points, build adjacency
  // =========================================================================

  const landPts: [number, number][] = [];
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (landWeight[x][y] > 0.4) landPts.push([x, y]);
    }
  }
  if (landPts.length === 0) {
    for (let i = 0; i < N; i++) landPts.push([W >> 1, H >> 1]);
  }

  const idToIdx: Record<string, number> = {};
  for (let i = 0; i < regionsData.length; i++) {
    idToIdx[regionsData[i].id ?? String(i)] = i;
  }

  const adjMatrix = make2d<boolean>(N, N, false);
  for (let i = 0; i < regionsData.length; i++) {
    for (const adjId of regionsData[i].adjacent_to ?? []) {
      if (adjId in idToIdx) {
        const j = idToIdx[adjId];
        adjMatrix[i][j] = true;
        adjMatrix[j][i] = true;
      }
    }
  }

  // =========================================================================
  // 5. Initial center placement (farthest-point sampling on land)
  // =========================================================================

  const centers: [number, number][] = [rng.choice(landPts).slice() as [number, number]];
  for (let k = 1; k < N; k++) {
    let bestPt: [number, number] | null = null;
    let maxDist = -1;
    for (let trial = 0; trial < 40; trial++) {
      const pt = rng.choice(landPts);
      let minD = Infinity;
      for (const c of centers) {
        const d = (pt[0] - c[0]) ** 2 + (pt[1] - c[1]) ** 2;
        if (d < minD) minD = d;
      }
      if (minD > maxDist) {
        maxDist = minD;
        bestPt = pt.slice() as [number, number];
      }
    }
    centers.push(bestPt!);
  }

  // =========================================================================
  // 6. Force-directed layout (120 iterations)
  // =========================================================================

  function closestLand(x: number, y: number): [number, number] {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix >= 0 && ix < W && iy >= 0 && iy < H && landWeight[ix][iy] > 0.4) {
      return [x, y];
    }
    let bestPt: [number, number] = centers[0];
    let bestDist = Infinity;
    for (const [px, py] of landPts) {
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestPt = [px, py];
      }
    }
    return bestPt;
  }

  const targetDist = 15.0;
  for (let iter = 0; iter < 120; iter++) {
    const forces: [number, number][] = Array.from({ length: N }, () => [0, 0]);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const dx = centers[j][0] - centers[i][0];
        const dy = centers[j][1] - centers[i][1];
        const dist = hypot(dx, dy) + 1e-4;
        let f: number;
        if (adjMatrix[i][j]) {
          f = (dist - targetDist) * 0.25;
        } else {
          f = -60.0 / (dist * dist);
        }
        forces[i][0] += f * (dx / dist);
        forces[i][1] += f * (dy / dist);
      }
      // Center gravity
      const cgx = W / 2;
      const cgy = H / 2;
      const dx = cgx - centers[i][0];
      const dy = cgy - centers[i][1];
      const dist = hypot(dx, dy) + 1e-4;
      forces[i][0] += (dx / dist) * 0.3;
      forces[i][1] += (dy / dist) * 0.3;
    }
    for (let i = 0; i < N; i++) {
      const nx = centers[i][0] + forces[i][0];
      const ny = centers[i][1] + forces[i][1];
      const cl = closestLand(nx, ny);
      centers[i][0] = cl[0];
      centers[i][1] = cl[1];
    }
  }

  // Snap centers to integer
  for (let i = 0; i < N; i++) {
    centers[i][0] = Math.round(centers[i][0]);
    centers[i][1] = Math.round(centers[i][1]);
  }

  // =========================================================================
  // 7. Multi-source Dijkstra region expansion
  // =========================================================================

  const costMap = make2d<number>(W, H, 0);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      costMap[x][y] = rng.uniform(1.0, 10.0);
    }
  }

  {
    const pq = new MinHeap<number[]>(cmpFirst);
    for (let i = 0; i < N; i++) {
      pq.push([0, centers[i][0], centers[i][1], i]);
    }
    while (pq.size > 0) {
      const [cost, cx, cy, color] = pq.pop();
      if (grid[cx][cy] !== -1) continue;
      grid[cx][cy] = color;
      for (const [dx, dy] of DIR4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[nx][ny] === -1) {
          if (landWeight[nx][ny] + rng.uniform(-0.1, 0.1) > 0.15) {
            pq.push([cost + costMap[nx][ny], nx, ny, color]);
          }
        }
      }
    }
  }

  // =========================================================================
  // 8. Value noise heightmap
  // =========================================================================

  function valueNoise(freq: number): number[][] {
    const noiseW = Math.floor(W / freq) + 3;
    const noiseH = Math.floor(H / freq) + 3;
    const noise: number[][] = [];
    for (let x = 0; x < noiseW; x++) {
      noise[x] = [];
      for (let y = 0; y < noiseH; y++) {
        noise[x][y] = rng.random();
      }
    }
    const hm = make2d<number>(W, H, 0);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const lx = x / freq;
        const ly = y / freq;
        const x1 = Math.floor(lx);
        const y1 = Math.floor(ly);
        let tx = lx - x1;
        let ty = ly - y1;
        tx = tx * tx * (3 - 2 * tx);
        ty = ty * ty * (3 - 2 * ty);
        const v00 = noise[x1][y1];
        const v10 = noise[x1 + 1][y1];
        const v01 = noise[x1][y1 + 1];
        const v11 = noise[x1 + 1][y1 + 1];
        hm[x][y] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
      }
    }
    return hm;
  }

  const hmBase = valueNoise(12);
  const hmDetail = valueNoise(4);

  const height = make2d<number>(W, H, 0);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (landWeight[x][y] > 0.01) {
        const rId = grid[x][y];
        let geoMod = 1.0;
        let freqMod = 1.0;
        if (rId >= 0) {
          const geo = regionsData[rId]?.geography ?? "plains";
          if (geo === "mountainous") {
            geoMod = 2.0;
            freqMod = 1.5;
          } else if (geo === "canyon") {
            geoMod = 0.5;
            freqMod = 3.0;
          } else {
            // plains
            geoMod = 0.3;
            freqMod = 0.5;
          }
        }
        const val =
          landWeight[x][y] +
          geoMod * (hmBase[x][y] * 0.5 + hmDetail[x][y] * 0.15 * freqMod);
        height[x][y] = Math.max(0.0, val);
      }
    }
  }

  // =========================================================================
  // 9. Contour lines (marching squares) + topo rects
  // =========================================================================

  const thresholds = [0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.1, 2.5];
  const contourSegs: string[] = [];
  const topoRects: MapGenerationOutput["topoRects"] = [];

  for (let x = 0; x < W - 1; x++) {
    for (let y = 0; y < H - 1; y++) {
      // Topo dot-matrix
      if (landWeight[x][y] > 0.05) {
        const hVal = height[x][y];
        const alpha = Math.max(0.0, Math.min(1.0, hVal / 2.5)) ** 1.3;
        if (alpha > 0.02) {
          topoRects.push({
            x: x * SCALE + 1,
            y: y * SCALE + 1,
            w: 8,
            h: 8,
            alpha: alpha * 0.5,
          });
        }
      }

      if (landWeight[x][y] < 0.1) continue;

      for (const th of thresholds) {
        const h00 = height[x][y];
        const h10 = height[x + 1][y];
        const h01 = height[x][y + 1];
        const h11 = height[x + 1][y + 1];
        const pts: [number, number][] = [];

        if ((h00 < th) !== (h10 < th)) {
          const t = (th - h00) / (h10 - h00 + 1e-5);
          pts.push([x + t, y]);
        }
        if ((h01 < th) !== (h11 < th)) {
          const t = (th - h01) / (h11 - h01 + 1e-5);
          pts.push([x + t, y + 1]);
        }
        if ((h00 < th) !== (h01 < th)) {
          const t = (th - h00) / (h01 - h00 + 1e-5);
          pts.push([x, y + t]);
        }
        if ((h10 < th) !== (h11 < th)) {
          const t = (th - h10) / (h11 - h10 + 1e-5);
          pts.push([x + 1, y + t]);
        }
        if (pts.length === 2) {
          contourSegs.push(
            `M ${pts[0][0] * SCALE} ${pts[0][1] * SCALE} L ${pts[1][0] * SCALE} ${pts[1][1] * SCALE}`,
          );
        }
      }
    }
  }

  const contourPath = contourSegs.join(" ");

  // =========================================================================
  // 10. Rivers (A* with gravity penalty)
  // =========================================================================

  const globalWaterCells = new Set<string>();
  const rivers: MapGenerationOutput["rivers"] = [];

  const oceanPts: [number, number][] = [];
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (grid[x][y] === -1) oceanPts.push([x, y]);
    }
  }

  function findRiverRoute(
    sx: number,
    sy: number,
    ex: number,
    ey: number,
  ): [number, number][] {
    const pq = new MinHeap<number[]>(cmpFirst);
    pq.push([0, 0, sx, sy]);
    const cameFrom = new Map<string, [number, number] | null>();
    const gScore = new Map<string, number>();
    cameFrom.set(ck(sx, sy), null);
    gScore.set(ck(sx, sy), 0);

    while (pq.size > 0) {
      const [, g, x, y] = pq.pop();
      if ((x === ex && y === ey) || (x !== sx && grid[x][y] === -1)) {
        // Reconstruct path
        const path: [number, number][] = [];
        let curr: [number, number] | null = [x, y];
        while (curr) {
          path.push(curr);
          curr = cameFrom.get(ck(curr[0], curr[1])) ?? null;
        }
        path.reverse();
        return path;
      }

      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const moveCost = dx !== 0 && dy !== 0 ? 1.414 : 1.0;
          const dh = height[nx][ny] - height[x][y];
          const tc = Math.max(0, dh) * 80.0 + moveCost + rng.uniform(0.0, 2.0);
          const tg = g + tc;
          const key = ck(nx, ny);
          if (tg < (gScore.get(key) ?? Infinity)) {
            cameFrom.set(key, [x, y]);
            gScore.set(key, tg);
            const heur = Math.sqrt((nx - ex) ** 2 + (ny - ey) ** 2) * 0.3;
            pq.push([tg + heur, tg, nx, ny]);
          }
        }
      }
    }
    return [];
  }

  for (let i = 0; i < regionsData.length; i++) {
    const rc = regionsData[i].river_count ?? rng.randint(1, 3);
    for (let r = 0; r < rc; r++) {
      const cand: [number, number, number][] = [];
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          if (grid[x][y] === i && landWeight[x][y] > 0.6) {
            cand.push([height[x][y], x, y]);
          }
        }
      }
      if (cand.length === 0) continue;
      cand.sort((a, b) => b[0] - a[0]);
      const topSlice = cand.slice(0, Math.max(1, Math.floor(cand.length / 10)));
      const chosen = rng.choice(topSlice);
      const rx = chosen[1];
      const ry = chosen[2];

      if (oceanPts.length > 0) {
        let tgtX = oceanPts[0][0];
        let tgtY = oceanPts[0][1];
        let minD = (tgtX - rx) ** 2 + (tgtY - ry) ** 2;
        for (const [ox, oy] of oceanPts) {
          const d = (ox - rx) ** 2 + (oy - ry) ** 2;
          if (d < minD) {
            minD = d;
            tgtX = ox;
            tgtY = oy;
          }
        }

        const path = findRiverRoute(rx, ry, tgtX, tgtY);
        if (path.length > 8) {
          for (const [px, py] of path) {
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                globalWaterCells.add(ck(Math.floor(px) + dx, Math.floor(py) + dy));
              }
            }
          }
          const smoothed = smoothPath(path, 4);
          const L = smoothed.length;
          const p1 = smoothed.slice(0, Math.floor(L * 0.25) + 1);
          const p2 = smoothed.slice(Math.floor(L * 0.25), Math.floor(L * 0.65) + 1);
          const p3 = smoothed.slice(Math.floor(L * 0.65));

          const d1 = "M " + p1.map((pt) => `${pt[0] * SCALE} ${pt[1] * SCALE}`).join(" L ");
          rivers.push({ path: d1, width: 0.5 });
          if (p2.length > 1) {
            const d2 = "M " + p2.map((pt) => `${pt[0] * SCALE} ${pt[1] * SCALE}`).join(" L ");
            rivers.push({ path: d2, width: 0.9 });
          }
          if (p3.length > 1) {
            const d3 = "M " + p3.map((pt) => `${pt[0] * SCALE} ${pt[1] * SCALE}`).join(" L ");
            rivers.push({ path: d3, width: 1.5 });
          }
        }
      }
    }
  }

  // =========================================================================
  // 11. Sub-zone Dijkstra splitting
  // =========================================================================

  const subGrid = make2d<number>(W, H, -1);
  const subLabels: MapGenerationOutput["subLabels"] = [];

  for (let i = 0; i < regionsData.length; i++) {
    const zones = regionsData[i].sub_zones ?? [];
    const M = zones.length;
    if (M <= 1) {
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          if (grid[x][y] === i) subGrid[x][y] = 0;
        }
      }
      if (M === 1) {
        subLabels.push({
          x: centers[i][0] * SCALE + 30,
          y: centers[i][1] * SCALE - 20,
          name: zones[0],
        });
      }
      continue;
    }

    const pts: [number, number][] = [];
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (grid[x][y] === i) pts.push([x, y]);
      }
    }
    if (pts.length < M) continue;

    const subCenters: [number, number][] = [rng.choice(pts).slice() as [number, number]];
    for (let k = 1; k < M; k++) {
      let bestPt: [number, number] | null = null;
      let maxDist = -1;
      for (let trial = 0; trial < 20; trial++) {
        const pt = rng.choice(pts);
        let minD = Infinity;
        for (const c of subCenters) {
          const d = (pt[0] - c[0]) ** 2 + (pt[1] - c[1]) ** 2;
          if (d < minD) minD = d;
        }
        if (minD > maxDist) {
          maxDist = minD;
          bestPt = pt.slice() as [number, number];
        }
      }
      if (bestPt) subCenters.push(bestPt);
    }

    const spq = new MinHeap<number[]>(cmpFirst);
    for (let zi = 0; zi < subCenters.length; zi++) {
      spq.push([0, subCenters[zi][0], subCenters[zi][1], zi]);
    }
    while (spq.size > 0) {
      const [cst, cx, cy, color] = spq.pop();
      if (subGrid[cx][cy] !== -1) continue;
      subGrid[cx][cy] = color;
      for (const [dx, dy] of DIR8) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[nx][ny] === i && subGrid[nx][ny] === -1) {
          const dh = Math.abs(height[nx][ny] - height[cx][cy]);
          spq.push([cst + 1.0 + dh * 5.0, nx, ny, color]);
        }
      }
    }

    for (let zi = 0; zi < subCenters.length && zi < M; zi++) {
      subLabels.push({
        x: subCenters[zi][0] * SCALE - 15,
        y: subCenters[zi][1] * SCALE - 15,
        name: zones[zi],
      });
    }
  }

  // =========================================================================
  // 12. Sub-zone boundary extraction (directed edge chaining)
  // =========================================================================

  const subSegSet = new Set<string>();
  for (let x = 0; x < W - 1; x++) {
    for (let y = 0; y < H - 1; y++) {
      if (grid[x][y] === -1) continue;
      const c1 = subGrid[x][y];
      if (grid[x][y + 1] === grid[x][y] && subGrid[x][y + 1] > c1) {
        subSegSet.add(sk(x, y + 1, x + 1, y + 1));
      }
      if (grid[x + 1][y] === grid[x][y] && subGrid[x + 1][y] > c1) {
        subSegSet.add(sk(x + 1, y, x + 1, y + 1));
      }
    }
  }

  // Parse segments back
  type Seg = { a: [number, number]; b: [number, number]; key: string };
  const subSegs: Seg[] = [];
  for (const key of Array.from(subSegSet)) {
    const [aStr, bStr] = key.split("|");
    const [ax, ay] = aStr.split(",").map(Number);
    const [bx, by] = bStr.split(",").map(Number);
    subSegs.push({ a: [ax, ay], b: [bx, by], key });
  }

  const subBorders: MapGenerationOutput["subBorders"] = [];
  {
    const remaining = new Set(subSegs.map((s) => s.key));
    const segMap = new Map<string, Seg>();
    for (const s of subSegs) segMap.set(s.key, s);

    while (remaining.size > 0) {
      const firstKey = remaining.values().next().value!;
      remaining.delete(firstKey);
      const firstSeg = segMap.get(firstKey)!;
      const pathPts: [number, number][] = [firstSeg.a, firstSeg.b];

      let found = true;
      while (found) {
        found = false;
        for (const candKey of Array.from(remaining)) {
          const cand = segMap.get(candKey)!;
          const last = pathPts[pathPts.length - 1];
          const first = pathPts[0];
          if (cand.a[0] === last[0] && cand.a[1] === last[1]) {
            pathPts.push(cand.b);
            remaining.delete(candKey);
            found = true;
            break;
          }
          if (cand.b[0] === last[0] && cand.b[1] === last[1]) {
            pathPts.push(cand.a);
            remaining.delete(candKey);
            found = true;
            break;
          }
          if (cand.b[0] === first[0] && cand.b[1] === first[1]) {
            pathPts.unshift(cand.a);
            remaining.delete(candKey);
            found = true;
            break;
          }
          if (cand.a[0] === first[0] && cand.a[1] === first[1]) {
            pathPts.unshift(cand.b);
            remaining.delete(candKey);
            found = true;
            break;
          }
        }
      }

      const smoothed = smoothPath(pathPts, 2);
      const d =
        "M " + smoothed.map((pt) => `${pt[0] * SCALE} ${pt[1] * SCALE}`).join(" L ");
      subBorders.push({ path: d });
    }
  }

  // =========================================================================
  // 13. Region boundary extraction (per-region directed edge chaining)
  // =========================================================================

  function getPaths(c: number): [number, number][][] {
    const segs = new Map<string, { a: [number, number]; b: [number, number] }>();
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (grid[x][y] !== c) continue;
        if (y === 0 || grid[x][y - 1] !== c) {
          const key = sk(x, y, x + 1, y);
          segs.set(key, { a: [x, y], b: [x + 1, y] });
        }
        if (y === H - 1 || grid[x][y + 1] !== c) {
          const key = sk(x + 1, y + 1, x, y + 1);
          segs.set(key, { a: [x + 1, y + 1], b: [x, y + 1] });
        }
        if (x === 0 || grid[x - 1][y] !== c) {
          const key = sk(x, y + 1, x, y);
          segs.set(key, { a: [x, y + 1], b: [x, y] });
        }
        if (x === W - 1 || grid[x + 1][y] !== c) {
          const key = sk(x + 1, y, x + 1, y + 1);
          segs.set(key, { a: [x + 1, y], b: [x + 1, y + 1] });
        }
      }
    }

    const paths: [number, number][][] = [];
    const remaining = new Set(segs.keys());
    while (remaining.size > 0) {
      const firstKey = remaining.values().next().value!;
      remaining.delete(firstKey);
      const firstSeg = segs.get(firstKey)!;
      const pathPts: [number, number][] = [firstSeg.a, firstSeg.b];

      let found = true;
      while (found) {
        found = false;
        const last = pathPts[pathPts.length - 1];
        for (const candKey of Array.from(remaining)) {
          const cand = segs.get(candKey)!;
          if (cand.a[0] === last[0] && cand.a[1] === last[1]) {
            pathPts.push(cand.b);
            remaining.delete(candKey);
            found = true;
            break;
          }
        }
      }
      paths.push(pathPts);
    }
    return paths.map((p) => smoothPath(p, 1));
  }

  // =========================================================================
  // 14. Outer contour (BFS flood-fill ocean, then edge extraction)
  // =========================================================================

  function getOuterContour(): [number, number][][] {
    const ocean = new Set<string>();
    const q: [number, number][] = [];

    // Seed from edges
    for (let x = 0; x < W; x++) {
      for (const y of [0, H - 1]) {
        if (grid[x][y] === -1) {
          const key = ck(x, y);
          if (!ocean.has(key)) {
            ocean.add(key);
            q.push([x, y]);
          }
        }
      }
    }
    for (let y = 0; y < H; y++) {
      for (const x of [0, W - 1]) {
        if (grid[x][y] === -1) {
          const key = ck(x, y);
          if (!ocean.has(key)) {
            ocean.add(key);
            q.push([x, y]);
          }
        }
      }
    }

    // BFS
    let qi = 0;
    while (qi < q.length) {
      const [cx, cy] = q[qi++];
      for (const [dx, dy] of DIR4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[nx][ny] === -1) {
          const key = ck(nx, ny);
          if (!ocean.has(key)) {
            ocean.add(key);
            q.push([nx, ny]);
          }
        }
      }
    }

    // Edge extraction
    const segs = new Map<string, { a: [number, number]; b: [number, number] }>();
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (grid[x][y] === -1) continue;
        if (y === 0 || ocean.has(ck(x, y - 1))) {
          const key = sk(x, y, x + 1, y);
          segs.set(key, { a: [x, y], b: [x + 1, y] });
        }
        if (y === H - 1 || ocean.has(ck(x, y + 1))) {
          const key = sk(x + 1, y + 1, x, y + 1);
          segs.set(key, { a: [x + 1, y + 1], b: [x, y + 1] });
        }
        if (x === 0 || ocean.has(ck(x - 1, y))) {
          const key = sk(x, y + 1, x, y);
          segs.set(key, { a: [x, y + 1], b: [x, y] });
        }
        if (x === W - 1 || ocean.has(ck(x + 1, y))) {
          const key = sk(x + 1, y, x + 1, y + 1);
          segs.set(key, { a: [x + 1, y], b: [x + 1, y + 1] });
        }
      }
    }

    const paths: [number, number][][] = [];
    const remaining = new Set(segs.keys());
    while (remaining.size > 0) {
      const firstKey = remaining.values().next().value!;
      remaining.delete(firstKey);
      const firstSeg = segs.get(firstKey)!;
      const pathPts: [number, number][] = [firstSeg.a, firstSeg.b];

      let found = true;
      while (found) {
        found = false;
        const last = pathPts[pathPts.length - 1];
        for (const candKey of Array.from(remaining)) {
          const cand = segs.get(candKey)!;
          if (cand.a[0] === last[0] && cand.a[1] === last[1]) {
            pathPts.push(cand.b);
            remaining.delete(candKey);
            found = true;
            break;
          }
        }
      }
      paths.push(pathPts);
    }
    return paths.map((p) => smoothPath(p, 1));
  }

  // Build outer contour
  const outerPaths = getOuterContour();
  const outerContourPath = outerPaths
    .map((p) => {
      let d = `M ${p[0][0] * SCALE} ${p[0][1] * SCALE}`;
      for (let i = 1; i < p.length; i++) d += ` L ${p[i][0] * SCALE} ${p[i][1] * SCALE}`;
      d += " Z";
      return d;
    })
    .join(" ");

  // Build per-region paths
  const regionPaths: MapGenerationOutput["regionPaths"] = [];
  for (let i = 0; i < N; i++) {
    const paths = getPaths(i);
    const color = PASTEL_COLORS[i % PASTEL_COLORS.length];
    const d = paths
      .map((p) => {
        let s = `M ${p[0][0] * SCALE} ${p[0][1] * SCALE}`;
        for (let j = 1; j < p.length; j++) s += ` L ${p[j][0] * SCALE} ${p[j][1] * SCALE}`;
        s += " Z";
        return s;
      })
      .join(" ");
    regionPaths.push({ id: `reg_${i}`, path: d, color });
  }

  // =========================================================================
  // 15. Lakes (BFS + Chaikin smoothing)
  // =========================================================================

  const lakes: MapGenerationOutput["lakes"] = [];

  // Helper: check if a grid cell is too close to any city center
  const nearCity = (x: number, y: number, minDist: number) =>
    centers.some(([cx, cy]) => (cx - x) ** 2 + (cy - y) ** 2 < minDist * minDist);

  for (let attempt = 0; attempt < 12; attempt++) {
    const lx = rng.randint(10, W - 10);
    const ly = rng.randint(10, H - 10);
    // Skip if too close to any city center
    if (landWeight[lx][ly] > 0.8 && !nearCity(lx, ly, 6)) {
      const lakeCells = new Set<string>();
      lakeCells.add(ck(lx, ly));
      const q: [number, number][] = [[lx, ly]];
      const targetSize = rng.randint(3, 40);
      let qi = 0;
      while (qi < q.length && lakeCells.size < targetSize) {
        const [cx, cy] = q[qi++];
        for (const [dx, dy] of DIR8) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (
            nx >= 0 &&
            nx < W &&
            ny >= 0 &&
            ny < H &&
            landWeight[nx][ny] > 0.3 &&
            !lakeCells.has(ck(nx, ny)) &&
            !nearCity(nx, ny, 4)
          ) {
            if (Math.abs(height[nx][ny] - height[cx][cy]) < 0.6 && rng.random() < 0.65) {
              lakeCells.add(ck(nx, ny));
              q.push([nx, ny]);
            }
          }
        }
      }

      if (lakeCells.size > 6) {
        // Add water cells
        for (const key of Array.from(lakeCells)) {
          const [x, y] = key.split(",").map(Number);
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              globalWaterCells.add(ck(x + dx, y + dy));
            }
          }
        }

        // Edge extraction
        const segs = new Map<string, { a: [number, number]; b: [number, number] }>();
        for (const key of Array.from(lakeCells)) {
          const [x, y] = key.split(",").map(Number);
          if (!lakeCells.has(ck(x, y - 1))) {
            const skey = sk(x, y, x + 1, y);
            segs.set(skey, { a: [x, y], b: [x + 1, y] });
          }
          if (!lakeCells.has(ck(x, y + 1))) {
            const skey = sk(x + 1, y + 1, x, y + 1);
            segs.set(skey, { a: [x + 1, y + 1], b: [x, y + 1] });
          }
          if (!lakeCells.has(ck(x - 1, y))) {
            const skey = sk(x, y + 1, x, y);
            segs.set(skey, { a: [x, y + 1], b: [x, y] });
          }
          if (!lakeCells.has(ck(x + 1, y))) {
            const skey = sk(x + 1, y, x + 1, y + 1);
            segs.set(skey, { a: [x + 1, y], b: [x + 1, y + 1] });
          }
        }

        // Chain segments into paths
        const remaining = new Set(segs.keys());
        const paths: [number, number][][] = [];
        while (remaining.size > 0) {
          const firstKey = remaining.values().next().value!;
          remaining.delete(firstKey);
          const firstSeg = segs.get(firstKey)!;
          const pathPts: [number, number][] = [firstSeg.a, firstSeg.b];

          let found = true;
          while (found) {
            found = false;
            const last = pathPts[pathPts.length - 1];
            for (const candKey of Array.from(remaining)) {
              const cand = segs.get(candKey)!;
              if (cand.a[0] === last[0] && cand.a[1] === last[1]) {
                pathPts.push(cand.b);
                remaining.delete(candKey);
                found = true;
                break;
              }
            }
          }
          paths.push(pathPts);
        }

        for (const p of paths) {
          const jittered: [number, number][] = p.map((pt) => [
            pt[0] + rng.uniform(-0.4, 0.4),
            pt[1] + rng.uniform(-0.4, 0.4),
          ]);
          const sm = smoothPolygon(jittered, 4);
          const d =
            "M " +
            sm.map((pt) => `${pt[0] * SCALE} ${pt[1] * SCALE}`).join(" L ") +
            " Z";
          lakes.push({ path: d });
        }
      }
    }
  }

  // =========================================================================
  // 16. Route finding (A* with terrain cost)
  // =========================================================================

  function findRoute(
    sx: number,
    sy: number,
    ex: number,
    ey: number,
  ): [number, number][] {
    const clampedSx = Math.floor(Math.max(0, Math.min(W - 1, sx)));
    const clampedSy = Math.floor(Math.max(0, Math.min(H - 1, sy)));
    const clampedEx = Math.floor(Math.max(0, Math.min(W - 1, ex)));
    const clampedEy = Math.floor(Math.max(0, Math.min(H - 1, ey)));

    const pq = new MinHeap<number[]>(cmpFirst);
    pq.push([0, 0, clampedSx, clampedSy]);
    const cameFrom = new Map<string, [number, number] | null>();
    const gScore = new Map<string, number>();
    cameFrom.set(ck(clampedSx, clampedSy), null);
    gScore.set(ck(clampedSx, clampedSy), 0);

    while (pq.size > 0) {
      const [, g, x, y] = pq.pop();
      if (x === clampedEx && y === clampedEy) {
        const path: [number, number][] = [];
        let curr: [number, number] | null = [x, y];
        while (curr) {
          path.push(curr);
          curr = cameFrom.get(ck(curr[0], curr[1])) ?? null;
        }
        path.reverse();
        return path;
      }

      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const moveCost = dx !== 0 && dy !== 0 ? 1.414 : 1.0;
          let tc = grid[nx][ny] !== -1 ? 1.0 : 60.0;
          if (grid[nx][ny] !== grid[x][y]) tc = 3.0;
          tc *= Math.max(0.2, costMap[nx][ny] * 0.8);
          const dh = Math.abs(height[nx][ny] - height[x][y]) * 5.0;
          const tg = g + moveCost * tc + dh;
          const key = ck(nx, ny);
          if (tg < (gScore.get(key) ?? Infinity)) {
            cameFrom.set(key, [x, y]);
            gScore.set(key, tg);
            const heur = Math.sqrt((nx - clampedEx) ** 2 + (ny - clampedEy) ** 2);
            pq.push([tg + heur, tg, nx, ny]);
          }
        }
      }
    }
    return [];
  }

  function drawRoute(
    path: [number, number][],
    startExact?: [number, number],
    endExact?: [number, number],
  ): string {
    if (path.length < 2) return "";
    // Sample every other point
    const sp: [number, number][] = [];
    for (let i = 0; i < path.length; i += 2) sp.push(path[i]);
    if (sp[sp.length - 1] !== path[path.length - 1]) sp.push(path[path.length - 1]);

    let d = `M ${startExact ? startExact[0] : sp[0][0] * SCALE} ${startExact ? startExact[1] : sp[0][1] * SCALE}`;
    for (let i = 1; i < sp.length - 1; i++) {
      d += ` L ${sp[i][0] * SCALE} ${sp[i][1] * SCALE}`;
    }
    d += ` L ${endExact ? endExact[0] : sp[sp.length - 1][0] * SCALE} ${endExact ? endExact[1] : sp[sp.length - 1][1] * SCALE}`;
    return d;
  }

  // =========================================================================
  // 17. MST trunk edges (union-find)
  // =========================================================================

  function distSq(u: number, v: number): number {
    return (centers[u][0] - centers[v][0]) ** 2 + (centers[u][1] - centers[v][1]) ** 2;
  }

  const edgesPossible: [number, number, number][] = [];
  for (let u = 0; u < N; u++) {
    for (let v = u + 1; v < N; v++) {
      edgesPossible.push([distSq(u, v), u, v]);
    }
  }
  edgesPossible.sort((a, b) => a[0] - b[0]);

  const uf: number[] = Array.from({ length: N }, (_, i) => i);
  function ufFind(i: number): number {
    if (uf[i] !== i) uf[i] = ufFind(uf[i]);
    return uf[i];
  }

  const trunkEdges: [number, number][] = [];
  for (const [, u, v] of edgesPossible) {
    if (ufFind(u) !== ufFind(v)) {
      uf[ufFind(u)] = ufFind(v);
      trunkEdges.push([u, v]);
    }
  }

  // =========================================================================
  // 18. Draw trunk routes
  // =========================================================================

  const edges: [string, string][] = [];
  const trunkRoutes: MapGenerationOutput["trunkRoutes"] = [];

  for (const [u, v] of trunkEdges) {
    const [cx1, cy1] = centers[u];
    const [cx2, cy2] = centers[v];
    let path = findRoute(cx1, cy1, cx2, cy2);
    if (path.length === 0) path = [[cx1, cy1], [cx2, cy2]];
    const d = drawRoute(path, [cx1 * SCALE, cy1 * SCALE], [cx2 * SCALE, cy2 * SCALE]);
    if (d) {
      trunkRoutes.push({ path: d });
      trunkRoutes.push({ path: d });
    }
    // Record L1 ↔ L1 edge (use actual region ID)
    edges.push([regionsData[u]?.id ?? String(u), regionsData[v]?.id ?? String(v)]);
  }

  // =========================================================================
  // 19. Node placement (random walk in region, avoiding water)
  // =========================================================================

  function getRandomNodeInRegion(
    pid: number,
    minDist: number,
    maxDist: number,
    avoidPts: [number, number][],
  ): [number, number] {
    const candidates: [number, number][] = [];
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (
          grid[x][y] === pid &&
          landWeight[x][y] > 0.2 &&
          !globalWaterCells.has(ck(x, y))
        ) {
          const d = Math.sqrt(
            (x - centers[pid][0]) ** 2 + (y - centers[pid][1]) ** 2,
          );
          if (d >= minDist && d <= maxDist) {
            let ok = true;
            for (const [px, py] of avoidPts) {
              if (Math.sqrt((x - px) ** 2 + (y - py) ** 2) <= 2.5) {
                ok = false;
                break;
              }
            }
            if (ok) candidates.push([x, y]);
          }
        }
      }
    }
    if (candidates.length > 0) return rng.choice(candidates);
    return [centers[pid][0], centers[pid][1]];
  }

  // =========================================================================
  // 20. Place L1 / L2 / L3 nodes and build routes
  // =========================================================================

  const l1Nodes: MapGenerationOutput["l1Nodes"] = [];
  const l2Nodes: MapGenerationOutput["l2Nodes"] = [];
  const l3Nodes: MapGenerationOutput["l3Nodes"] = [];
  const branchL2Routes: MapGenerationOutput["branchL2Routes"] = [];
  const branchL3Routes: MapGenerationOutput["branchL3Routes"] = [];

  const placedNodes: Map<number, [number, number][]> = new Map();
  for (let i = 0; i < N; i++) {
    placedNodes.set(i, [[centers[i][0], centers[i][1]]]);
  }

  for (let i = 0; i < N; i++) {
    const [cx, cy] = centers[i];
    const sx = cx * SCALE;
    const sy = cy * SCALE;
    const regData = regionsData[i];

    l1Nodes.push({
      id: regData.id ?? String(i),
      x: sx,
      y: sy,
      nameCn: regData.l1_name_cn ?? `DOMAIN ${i}`,
      nameEn: regData.l1_name_en ?? `NODE // ${i}`,
    });

    const l2Coords: [number, number][] = [];
    const placed = placedNodes.get(i)!;

    for (const nm of regData.l2_nodes ?? []) {
      const [ex, ey] = getRandomNodeInRegion(i, 6, 18, placed);
      placed.push([ex, ey]);
      const lx = ex * SCALE;
      const ly = ey * SCALE;

      let path = findRoute(cx, cy, ex, ey);
      if (path.length === 0) path = [[cx, cy], [ex, ey]];
      const d = drawRoute(path, [sx, sy], [lx, ly]);
      if (d) branchL2Routes.push({ path: d });
      // Record L1 ↔ L2 edge
      const l2Id = `l2_${l2Nodes.length}`;
      edges.push([regData.id ?? String(i), l2Id]);

      // Connect to closest existing L2 node
      if (l2Coords.length > 0) {
        let clX = l2Coords[0][0];
        let clY = l2Coords[0][1];
        let minD = (clX - ex) ** 2 + (clY - ey) ** 2;
        for (const [px, py] of l2Coords) {
          const d2 = (px - ex) ** 2 + (py - ey) ** 2;
          if (d2 < minD) {
            minD = d2;
            clX = px;
            clY = py;
          }
        }
        let path2 = findRoute(ex, ey, clX, clY);
        if (path2.length === 0) path2 = [[ex, ey], [clX, clY]];
        const d2 = drawRoute(path2, [lx, ly], [clX * SCALE, clY * SCALE]);
        if (d2) branchL2Routes.push({ path: d2 });
        // Record L2 ↔ L2 edge (find closest L2's index)
        const closestL2Idx = l2Coords.findIndex(([px, py]) => px === clX && py === clY);
        if (closestL2Idx >= 0) {
          const baseL2Idx = l2Nodes.length - l2Coords.length;
          edges.push([l2Id, `l2_${baseL2Idx + closestL2Idx}`]);
        }
      }

      l2Nodes.push({ x: lx, y: ly, name: nm, regionIdx: i });
      l2Coords.push([ex, ey]);
    }

    const l3Coords: [number, number][] = [];

    for (const nm of regData.l3_nodes ?? []) {
      const [ex, ey] = getRandomNodeInRegion(i, 3, 10, placed);
      placed.push([ex, ey]);
      const lx = ex * SCALE;
      const ly = ey * SCALE;

      const l3Id = `l3_${l3Nodes.length}`;
      if (l2Coords.length > 0) {
        // Connect to closest L2 node
        let tgtX = l2Coords[0][0];
        let tgtY = l2Coords[0][1];
        let minD = (tgtX - ex) ** 2 + (tgtY - ey) ** 2;
        let closestL2CoordIdx = 0;
        for (let ci = 0; ci < l2Coords.length; ci++) {
          const [px, py] = l2Coords[ci];
          const d2 = (px - ex) ** 2 + (py - ey) ** 2;
          if (d2 < minD) { minD = d2; tgtX = px; tgtY = py; closestL2CoordIdx = ci; }
        }
        let path = findRoute(tgtX, tgtY, ex, ey);
        if (path.length === 0) path = [[tgtX, tgtY], [ex, ey]];
        const d = drawRoute(path, [tgtX * SCALE, tgtY * SCALE], [lx, ly]);
        if (d) branchL3Routes.push({ path: d });
        // Record L3 ↔ L2 edge
        const baseL2Idx = l2Nodes.length - l2Coords.length;
        edges.push([l3Id, `l2_${baseL2Idx + closestL2CoordIdx}`]);
      } else {
        let path = findRoute(cx, cy, ex, ey);
        if (path.length === 0) path = [[cx, cy], [ex, ey]];
        const d = drawRoute(path, [sx, sy], [lx, ly]);
        if (d) branchL3Routes.push({ path: d });
        // Record L3 ↔ L1 edge (no L2 in this region)
        edges.push([l3Id, regData.id ?? String(i)]);
      }

      // Connect to closest L3 node if close enough
      if (l3Coords.length > 0) {
        let clX = l3Coords[0][0];
        let clY = l3Coords[0][1];
        let minD = (clX - ex) ** 2 + (clY - ey) ** 2;
        let closestL3CoordIdx = 0;
        for (let ci = 0; ci < l3Coords.length; ci++) {
          const [px, py] = l3Coords[ci];
          const d2 = (px - ex) ** 2 + (py - ey) ** 2;
          if (d2 < minD) { minD = d2; clX = px; clY = py; closestL3CoordIdx = ci; }
        }
        if ((clX - ex) ** 2 + (clY - ey) ** 2 < 150) {
          let path2 = findRoute(ex, ey, clX, clY);
          if (path2.length === 0) path2 = [[ex, ey], [clX, clY]];
          const d2 = drawRoute(path2, [lx, ly], [clX * SCALE, clY * SCALE]);
          if (d2) branchL3Routes.push({ path: d2 });
          // Record L3 ↔ L3 edge
          const baseL3Idx = l3Nodes.length - l3Coords.length;
          edges.push([l3Id, `l3_${baseL3Idx + closestL3CoordIdx}`]);
        }
      }

      l3Nodes.push({ x: lx, y: ly, name: nm, regionIdx: i });
      l3Coords.push([ex, ey]);
    }
  }

  // =========================================================================
  // Assemble output
  // =========================================================================

  return {
    gridWidth: W,
    gridHeight: H,
    scale: SCALE,

    regionPaths,
    outerContourPath,

    contourPath,
    topoRects,

    rivers,
    lakes,

    subBorders,
    subLabels,

    trunkRoutes,
    branchL2Routes,
    branchL3Routes,

    l1Nodes,
    l2Nodes,
    l3Nodes,
    edges,

    header: input.map_settings.header ?? "A.E.G.I.S. // ADVANCED TOPOGRAPHY",
    title: input.map_settings.title ?? "SECTOR OMEGA",
  };
}
