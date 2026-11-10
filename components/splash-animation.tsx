"use client";

import { useLayoutEffect, useRef } from "react";

import { isTouchPrimary } from "@/lib/shell-layout-mode";

const SCRIPT = [
  { side: "right", text: "you ever zone out mid-toast?", start: 80, type: 0 },
  { side: "left", text: "the bread became a small sunset.", start: 560, type: 310 },
  { side: "right", text: "beautiful. also concerning.", start: 1540, type: 0 },
  { side: "left", text: "let it breathe until it remembers.", start: 2140, type: 340 }
] as const;

const T = {
  detach: 3480,
  morph: 3630,
  rise: 3840,
  titleStart: 7520,
  tagline: 8520
};

const KLEIN = "#174BFF";
const KLEIN_DEEP = "#0B2ED8";
const PAPER = "#F1F2F6";
const INK = "#1A1A1A";
const FONT_UI = "\"Inter\", -apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif";
const FONT_SERIF = "\"Instrument Serif\", Georgia, \"Times New Roman\", serif";
const FONT_MONO = "\"JetBrains Mono\", ui-monospace, monospace";

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

function bounceOut(x: number) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

function drawPillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawBalloonPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, organic = 0) {
  const ow = w * (1 + organic * 0.025);
  const oh = h * (1 - organic * 0.015);
  const topY = cy - oh * 0.5;
  const botY = cy + oh * 0.48;
  ctx.beginPath();
  ctx.moveTo(cx, topY);
  ctx.bezierCurveTo(cx + ow * 0.39, topY + oh * 0.015, cx + ow * 0.52, cy - oh * 0.19, cx + ow * 0.49, cy + oh * 0.07);
  ctx.bezierCurveTo(cx + ow * 0.47, cy + oh * 0.31, cx + ow * 0.27, botY - oh * 0.01, cx + ow * 0.075, botY);
  ctx.bezierCurveTo(cx + ow * 0.035, botY + oh * 0.015, cx - ow * 0.035, botY + oh * 0.015, cx - ow * 0.075, botY);
  ctx.bezierCurveTo(cx - ow * 0.28, botY - oh * 0.005, cx - ow * 0.47, cy + oh * 0.31, cx - ow * 0.49, cy + oh * 0.07);
  ctx.bezierCurveTo(cx - ow * 0.52, cy - oh * 0.19, cx - ow * 0.39, topY + oh * 0.015, cx, topY);
  ctx.closePath();
}

export function SplashAnimation() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const stageEl = stageRef.current;
    const canvasEl = canvasRef.current;
    const context = canvasEl?.getContext("2d");
    if (!stageEl || !canvasEl || !context) return;
    const stage: HTMLDivElement = stageEl;
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;
    const supportsCanvasFilter = typeof (ctx as CanvasRenderingContext2D & { filter?: string }).filter === "string";
    const useSoftEdgeFallback =
      !supportsCanvasFilter ||
      isTouchPrimary();

    let W = 0;
    let H = 0;
    let raf = 0;
    let resizeTimer = 0;
    let startTime = 0;
    let pausedElapsed = 0;
    let isAnimating = false;
    let titleFontSize = 80;
    let renderDpr = 1;
    // 每帧重建渐变和测量文本是纯浪费：这些只跟画布尺寸/字号有关，缓存起来。
    let bgGradient: CanvasGradient | null = null;
    let bgGradientKey = "";
    let taglineKey = "";
    let taglineWidths: number[] = [];
    const charsSpawnedFor = new Set<Bubble>();

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderDpr = dpr;
      const r = stage.getBoundingClientRect();
      W = Math.max(1, r.width);
      H = Math.max(1, r.height);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    class Speck {
      x = 0;
      y = 0;
      r = 1;
      vy = 0;
      vx = 0;
      alpha = 0.2;
      tone = true;
      swayP = 0;
      constructor(initial: boolean) {
        this.reset(initial);
      }
      reset(initial: boolean) {
        this.x = Math.random() * W;
        this.y = initial ? Math.random() * H : H + 8;
        this.r = rand(0.2, 1.5);
        this.vy = -rand(0.05, 0.32);
        this.vx = rand(-0.1, 0.1);
        this.alpha = rand(0.06, 0.32);
        this.tone = Math.random() < 0.7;
        this.swayP = Math.random() * Math.PI * 2;
      }
      update() {
        this.swayP += 0.01;
        this.x += this.vx + Math.sin(this.swayP) * 0.05;
        this.y += this.vy;
        if (this.y < -10) this.reset(false);
      }
      draw() {
        ctx.fillStyle = this.tone ? `rgba(23,75,255,${this.alpha})` : `rgba(40,40,40,${this.alpha * 0.65})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    class Bubble {
      side: "left" | "right";
      text: string;
      idx: number;
      fontSize: number;
      padX: number;
      textW: number;
      w: number;
      h: number;
      textColor: string;
      detachColor: string;
      chatBaseY: number;
      yStep: number;
      ay: number;
      ax: number;
      balloonCenterX: number;
      balloonScale: number;
      scale = 0;
      morph = 0;
      driftX = 0;
      driftY = 0;
      swayPhase: number;
      charsOut = false;
      textReveal = 0;
      showTyping = false;
      showText = false;
      config: typeof SCRIPT[number];
      constructor(config: typeof SCRIPT[number], idx: number) {
        this.side = config.side;
        this.text = config.text;
        this.idx = idx;
        this.config = config;
        this.fontSize = Math.max(13, Math.min(16, W * 0.042));
        this.padX = this.fontSize * 0.86;
        const padY = this.fontSize * 0.52;
        this.textColor = this.side === "left" ? INK : "#FFFFFF";
        this.detachColor = this.side === "left" ? INK : KLEIN_DEEP;
        ctx.font = `300 ${this.fontSize}px ${FONT_UI}`;
        this.textW = ctx.measureText(this.text).width;
        this.w = this.textW + this.padX * 2;
        this.h = this.fontSize * 1.7 + padY * 0.4;
        const margin = W * 0.07;
        this.chatBaseY = H * 0.61;
        this.yStep = H * 0.072;
        this.ay = this.chatBaseY;
        this.ax = this.side === "left" ? margin : W - margin - this.w;
        const sideIndex = Math.floor(idx / 2);
        const leftFloatSlots = [0.42, 0.25, 0.44, 0.27];
        const rightFloatSlots = [0.58, 0.75, 0.56, 0.73];
        const balloonScales = [0.78, 0.67, 0.86, 0.72, 0.64, 0.82, 0.7, 0.76];
        this.balloonCenterX = W * (this.side === "left" ? leftFloatSlots[sideIndex % leftFloatSlots.length] : rightFloatSlots[sideIndex % rightFloatSlots.length]);
        this.balloonScale = balloonScales[idx % balloonScales.length];
        this.swayPhase = idx * 0.7;
      }
      update(t: number, visibleCount: number) {
        const at = this.config.start;
        if (t < at) {
          this.ay = this.chatBaseY;
        } else {
          const targetRow = this.idx - Math.max(0, visibleCount - 1);
          this.ay = lerp(this.ay, this.chatBaseY + targetRow * this.yStep, 0.16);
        }
        this.scale = t < at ? 0 : easeOutBack(clamp((t - at) / 440, 0, 1));
        if (this.scale > 0) {
          if (this.config.type > 0 && t < at + this.config.type) {
            this.showTyping = true;
            this.showText = false;
            this.textReveal = 0;
          } else {
            this.showTyping = false;
            this.showText = true;
            const revealDur = Math.max(this.config.type > 0 ? 360 : 220, this.text.length * (this.config.type > 0 ? 32 : 26));
            this.textReveal = clamp((t - at - this.config.type) / revealDur, 0, 1);
          }
        }
        this.morph = t > T.morph ? clamp((t - T.morph) / 720, 0, 1) : 0;
        if (t > T.rise) {
          const dt = (t - T.rise) / 1000;
          this.driftY = -dt * (70 + this.idx * 4) - Math.pow(dt, 1.4) * 16;
          this.swayPhase += 0.026;
          this.driftX = Math.sin(this.swayPhase + this.idx) * (9 + this.idx * 1.5);
        }
      }
      draw(t: number) {
        if (this.scale <= 0.001) return;
        const baseCx = this.ax + this.w / 2;
        const cx = lerp(baseCx, this.balloonCenterX + this.driftX, this.morph);
        const cy = this.ay + this.h / 2 + this.driftY;
        const m = this.morph;
        const squish = m > 0 ? 1 - 0.12 * Math.sin(m * Math.PI) : 1;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(this.scale * squish, this.scale * squish);
        const target = Math.max(this.w, this.h);
        const sw = lerp(this.w, target * 0.46 * this.balloonScale, m);
        const sh = lerp(this.h, target * 0.62 * this.balloonScale, m);
        const radius = lerp(this.h / 2, Math.min(sw, sh) * 0.46, m);
        const softEdge = Math.pow(1 - clamp(m / 0.72, 0, 1), 1.8);
        if (softEdge > 0.01) {
          ctx.shadowColor = this.side === "left" ? `rgba(255,255,255,${0.68 * softEdge})` : `rgba(26,60,240,${0.24 * softEdge})`;
          ctx.shadowBlur = this.side === "left" ? 10 * softEdge : 14 * softEdge;
        }
        const drawBubbleShape = () => {
          if (m < 0.985) drawPillPath(ctx, -sw / 2, -sh / 2, sw, sh, radius);
          else drawBalloonPath(ctx, 0, 0, sw, sh, Math.sin(this.swayPhase + this.idx));
        };
        const drawExpandedBubbleShape = (expand: number) => {
          if (m < 0.985) {
            drawPillPath(ctx, -sw / 2 - expand, -sh / 2 - expand, sw + expand * 2, sh + expand * 2, radius + expand);
          } else {
            drawBalloonPath(ctx, 0, 0, sw + expand * 2, sh + expand * 2, Math.sin(this.swayPhase + this.idx));
          }
        };
        const fillColor = this.side === "right" ? KLEIN : "#FFFFFF";
        ctx.fillStyle = fillColor;
        const edgeBlur = 2.4 * softEdge;
        if (edgeBlur > 0.06 && useSoftEdgeFallback) {
          ctx.shadowColor = "transparent";
          const blurSize = Math.max(1.2, edgeBlur * 1.35);
          const passes = [
            { expand: blurSize * 2.2, alpha: 0.07 },
            { expand: blurSize * 1.55, alpha: 0.12 },
            { expand: blurSize * 0.95, alpha: 0.20 },
            { expand: blurSize * 0.42, alpha: 0.34 },
            { expand: 0, alpha: 0.58 }
          ];
          ctx.save();
          for (const pass of passes) {
            ctx.globalAlpha = pass.alpha;
            drawExpandedBubbleShape(pass.expand);
            ctx.fill();
          }
          ctx.restore();
        } else {
          drawBubbleShape();
          ctx.filter = edgeBlur > 0.06 ? `blur(${edgeBlur}px)` : "none";
          ctx.fill();
          ctx.filter = "none";
        }
        ctx.shadowColor = "transparent";
        if (m > 0.3) {
          ctx.globalAlpha = ((m - 0.3) / 0.7) * (this.side === "left" ? 0.55 : 0.5);
          ctx.fillStyle = "#FFFFFF";
          ctx.beginPath();
          ctx.ellipse(-sw * 0.23, -sh * 0.31, sw * 0.085, sh * 0.13, 0.48, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (m > 0.55) {
          ctx.globalAlpha = (m - 0.55) / 0.45;
          ctx.fillStyle = this.side === "right" ? KLEIN_DEEP : "#E8E5DD";
          ctx.beginPath();
          const ny = sh / 2;
          ctx.moveTo(-3.5, ny - 1);
          ctx.lineTo(3.5, ny - 1);
          ctx.lineTo(2.2, ny + 4.5);
          ctx.lineTo(-2.2, ny + 4.5);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (m > 0.25) {
          const sa = (m - 0.25) / 0.75;
          const len = (108 + this.idx * 6) * sa;
          const sw1 = Math.sin(this.swayPhase * 1.4) * 9;
          const sw2 = Math.sin(this.swayPhase * 1.4 + 1) * 7;
          ctx.strokeStyle = this.side === "left" ? "rgba(120,120,120,0.7)" : "rgba(0,20,168,0.85)";
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(0, sh / 2 + 4);
          ctx.bezierCurveTo(sw2 * 0.5, sh / 2 + 4 + len * 0.35, sw1 * 0.7, sh / 2 + 4 + len * 0.7, sw1, sh / 2 + 4 + len);
          ctx.stroke();
        }
        if (!this.charsOut) {
          if (this.showTyping) drawTypingDots(t, this.side === "left" ? "rgba(120,120,120,0.85)" : "rgba(255,255,255,0.85)");
          else if (this.showText) {
            ctx.fillStyle = this.textColor;
            ctx.font = `300 ${this.fontSize}px ${FONT_UI}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.textReveal < 1 ? this.text.slice(0, Math.ceil(this.text.length * this.textReveal)) : this.text, 0, 0);
          }
        }
        ctx.restore();
      }
    }

    function drawTypingDots(t: number, color: string) {
      for (let i = 0; i < 3; i++) {
        const phase = ((t * 0.0048) + i * 0.22) % 1.1;
        const wave = Math.sin(phase * Math.PI / 1.1);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.3 + Math.max(0, wave) * 0.7;
        ctx.beginPath();
        ctx.arc((i - 1) * 8, -wave * 1.6, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    class FloatChar {
      vx = rand(-0.95, 0.95);
      vy = -rand(0.7, 1.9);
      rot = rand(-0.18, 0.18);
      rotV = rand(-0.022, 0.022);
      alpha = 1;
      swayPhase = Math.random() * Math.PI * 2;
      swayAmp = rand(0.18, 0.55);
      constructor(public ch: string, public x: number, public y: number, public color: string, public size: number) {}
      update() {
        this.swayPhase += 0.04;
        this.x += this.vx + Math.sin(this.swayPhase) * this.swayAmp;
        this.y += this.vy;
        this.vy *= 0.991;
        this.vx *= 0.991;
        if (this.vy > -0.55) this.vy -= 0.009;
        this.rot += this.rotV;
        if (this.y < H * 0.13) this.alpha = clamp(this.y / (H * 0.13), 0, 1);
      }
      draw() {
        if (this.alpha <= 0) return;
        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rot);
        ctx.fillStyle = this.color;
        ctx.font = `300 ${this.size}px ${FONT_UI}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(this.ch, 0, 0);
        ctx.restore();
      }
    }

    class TitleLetter {
      scale = 0;
      opacity = 0;
      x: number;
      y: number;
      rot = 0;
      startTime: number;
      bobPhase: number;
      constructor(public ch: string, public tx: number, public ty: number, public idx: number, public fontSize: number) {
        this.x = tx;
        this.y = ty + 100;
        this.startTime = T.titleStart + idx * 110;
        this.bobPhase = idx * 0.7 + Math.random() * 0.3;
      }
      update(t: number) {
        const dt = t - this.startTime;
        if (dt < 0) {
          this.opacity = 0;
          return;
        }
        if (dt < 760) {
          const p = dt / 760;
          const e = bounceOut(p);
          this.x = this.tx;
          this.y = this.ty + (1 - e) * 110;
          this.scale = e;
          this.opacity = clamp(p * 1.6, 0, 1);
          this.rot = (1 - e) * 0.2 * (this.idx % 2 ? 1 : -1);
        } else {
          const bt = (dt - 760) / 1000;
          this.x = this.tx + Math.sin(bt * 1.25 + this.bobPhase) * 1.8;
          this.y = this.ty + Math.sin(bt * 1.65 + this.bobPhase) * 4;
          this.scale = 1 + Math.sin(bt * 2 + this.bobPhase) * 0.028;
          this.rot = Math.sin(bt * 1.4 + this.bobPhase) * 0.03;
          this.opacity = 1;
        }
      }
      // 每个字母每帧要画 1 次正形 + 8 次偏移描边，6 个字母就是 54 次 fillText/帧。
      // 预渲染成离屏精灵后每帧只需 1 次 drawImage。
      sprite: HTMLCanvasElement | null = null;
      spriteCssSize = 0;
      buildSprite() {
        const pad = 4;
        const cssSize = Math.ceil(this.fontSize * 1.4) + pad * 2;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(cssSize * renderDpr));
        canvas.height = Math.max(1, Math.ceil(cssSize * renderDpr));
        const c = canvas.getContext("2d");
        if (!c) return;
        c.scale(renderDpr, renderDpr);
        c.font = `italic 400 ${this.fontSize}px ${FONT_SERIF}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        const cx = cssSize / 2;
        const cy = cssSize / 2;
        c.fillStyle = "rgba(23,75,255,0.09)";
        for (const [dx, dy] of [[-1.6, 0], [1.6, 0], [0, -1.6], [0, 1.6], [-1.1, -1.1], [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1]]) {
          c.fillText(this.ch, cx + dx, cy + dy);
        }
        c.fillStyle = "rgba(23,75,255,0.42)";
        c.fillText(this.ch, cx, cy);
        this.sprite = canvas;
        this.spriteCssSize = cssSize;
      }
      draw() {
        if (this.opacity <= 0) return;
        if (!this.sprite) this.buildSprite();
        if (!this.sprite) return;
        const size = this.spriteCssSize;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rot);
        ctx.scale(this.scale, this.scale);
        ctx.drawImage(this.sprite, -size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }

    let bubbles: Bubble[] = [];
    let specks: Speck[] = [];
    let chars: FloatChar[] = [];
    let titles: TitleLetter[] = [];

    function init(elapsed = 0) {
      resize();
      bubbles = SCRIPT.map((item, index) => new Bubble(item, index));
      specks = Array.from({ length: Math.max(8, Math.floor(W * H / 12000)) }, () => new Speck(true));
      chars = [];
      charsSpawnedFor.clear();
      titles = [];
      titleFontSize = Math.max(54, Math.min(96, W * 0.22));
      ctx.font = `italic 400 ${titleFontSize}px ${FONT_SERIF}`;
      const word = "pneuma";
      const widths = [...word].map((c) => ctx.measureText(c).width);
      const spacing = titleFontSize * 0.04;
      const total = widths.reduce((sum, width) => sum + width, 0) + spacing * (word.length - 1);
      let xc = W / 2 - total / 2;
      const titleY = H * 0.5;
      for (let i = 0; i < word.length; i++) {
        titles.push(new TitleLetter(word[i], xc + widths[i] / 2, titleY, i, titleFontSize));
        xc += widths[i] + spacing;
      }
      startTime = performance.now() - elapsed;
    }

    function getElapsed() {
      return startTime > 0 ? Math.max(0, performance.now() - startTime) : 0;
    }

    function spawnCharsFromBubble(b: Bubble) {
      if (charsSpawnedFor.has(b)) return;
      charsSpawnedFor.add(b);
      const cy = b.ay + b.h / 2 + b.driftY;
      ctx.font = `300 ${b.fontSize}px ${FONT_UI}`;
      let cursor = b.ax + b.w / 2 - b.textW / 2 + b.driftX;
      for (const ch of b.text) {
        const cw = ctx.measureText(ch).width;
        if (ch !== " ") chars.push(new FloatChar(ch, cursor + cw / 2, cy, b.detachColor, b.fontSize));
        cursor += cw;
      }
      b.charsOut = true;
    }

    function frame(now: number) {
      if (!isAnimating || document.visibilityState === "hidden") return;
      const t = now - startTime;
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
      const bgKey = `${W}x${H}`;
      if (!bgGradient || bgGradientKey !== bgKey) {
        const grad = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.75);
        grad.addColorStop(0, "rgba(23,75,255,0)");
        grad.addColorStop(1, "rgba(23,75,255,0.08)");
        bgGradient = grad;
        bgGradientKey = bgKey;
      }
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, W, H);
      specks.forEach((s) => { s.update(); s.draw(); });
      const visibleCount = SCRIPT.reduce((count, item) => count + (t >= item.start ? 1 : 0), 0);
      bubbles.forEach((b) => b.update(t, visibleCount));
      if (t > T.detach) bubbles.forEach((b, i) => { if (t > T.detach + i * 90) spawnCharsFromBubble(b); });
      bubbles.forEach((b) => b.draw(t));
      chars.forEach((c) => { c.update(); c.draw(); });
      titles.forEach((tl) => { tl.update(t); tl.draw(); });
      if (t > T.tagline) {
        const op = clamp((t - T.tagline) / 900, 0, 0.7);
        const txt = "BREATH  ·  AI";
        const ls = 2.2;
        ctx.fillStyle = `rgba(23,75,255,${op})`;
        ctx.font = `300 10px ${FONT_MONO}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const taglineK = `${txt}|${W}`;
        if (taglineKey !== taglineK) {
          taglineWidths = [...txt].map((c) => ctx.measureText(c).width);
          taglineKey = taglineK;
        }
        const ws = taglineWidths;
        const totalW = ws.reduce((sum, width) => sum + width + ls, 0) - ls;
        let xx = W / 2 - totalW / 2;
        for (let i = 0; i < txt.length; i++) {
          ctx.fillText(txt[i], xx + ws[i] / 2, H * 0.5 + titleFontSize * 0.55);
          xx += ws[i] + ls;
        }
      }
      raf = requestAnimationFrame(frame);
    }

    function stopAnimation() {
      isAnimating = false;
      cancelAnimationFrame(raf);
    }

    function startAnimation(elapsed = 0) {
      stopAnimation();
      init(elapsed);
      isAnimating = true;
      frame(performance.now());
    }

    const onResize = () => {
      window.clearTimeout(resizeTimer);
      const elapsed = isAnimating ? getElapsed() : pausedElapsed;
      resizeTimer = window.setTimeout(() => startAnimation(elapsed), 120);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        pausedElapsed = getElapsed();
        stopAnimation();
        return;
      }
      startAnimation(pausedElapsed);
    };
    const onPageShow = () => startAnimation(isAnimating ? getElapsed() : pausedElapsed);

    startAnimation(0);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      stopAnimation();
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <div ref={stageRef} className="splash-animation-stage" aria-hidden>
      <canvas ref={canvasRef} className="splash-animation-canvas" />
      <div className="splash-animation-grain" />
      <div className="splash-animation-corner">pneuma / 0.1</div>
      <div className="splash-animation-corner splash-animation-corner-right">no.001</div>
    </div>
  );
}
