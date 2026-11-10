// 中文字体子集化。
//
// 仓库里的中文展示字体原本是全字符集（Noto Serif SC 有 30220 个字形、10.4MB），
// 但它们只用于标题、手写体、游戏大厅这类展示场景。全量字形让 APK 里 46MB 的
// 体积白白花在几乎不会出现的生僻字上，也让首次启动的字体预热要下载几十 MB。
//
// 这里把 public/fonts 下的大字体裁到「GB2312 6763 常用汉字 + ASCII + 拉丁扩展
// + 中文标点 + 全角形式」。裁掉的生僻字会逐字回退到后面的字体，不会变成豆腐块。
//
// 用法：npm run build:fonts
// 依赖：pip install fonttools brotli
//
// 脚本就地改写 public/fonts 里的文件，完整原版在该文件被裁掉的上一版提交里，
// 需要恢复时从 git 历史取回即可。

import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = path.join(ROOT, "public/fonts");
// 小于这个体积的字体（拉丁字体、装饰小字体）不值得处理
const MIN_BYTES = 400 * 1024;

/** GB2312 覆盖的全部字符：用解码器把双字节码位反过来枚举，不依赖第三方编码库。 */
function gb2312Chars() {
    const decoder = new TextDecoder("gb2312");
    const chars = new Set();
    for (let hi = 0xa1; hi <= 0xf7; hi += 1) {
        for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
            const ch = decoder.decode(Uint8Array.of(hi, lo));
            if (ch && ch.length === 1 && ch !== "\uFFFD") chars.add(ch);
        }
    }
    return chars;
}

function buildCharset() {
    const chars = gb2312Chars();
    for (let cp = 0x20; cp <= 0x7e; cp += 1) chars.add(String.fromCharCode(cp));
    for (const [from, to] of [[0xa0, 0x24f], [0x2000, 0x206f], [0x3000, 0x303f], [0xff00, 0xffef]]) {
        for (let cp = from; cp <= to; cp += 1) chars.add(String.fromCharCode(cp));
    }
    for (const ch of "“”‘’—…·、。，！？；：（）《》〈〉「」『』【】〔〕～￥") chars.add(ch);
    return [...chars].sort().join("");
}

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full));
        else if (entry.name.endsWith(".woff2")) out.push(full);
    }
    return out;
}

const charset = buildCharset();
console.log(`charset: ${charset.length} chars (GB2312 + ASCII + punctuation)`);

const tmp = await mkdtemp(path.join(tmpdir(), "pneuma-fonts-"));
const charsetFile = path.join(tmp, "charset.txt");
await writeFile(charsetFile, charset, "utf8");

let totalBefore = 0;
let totalAfter = 0;
let processed = 0;
for (const file of (await walk(FONT_DIR)).sort()) {
    const before = (await stat(file)).size;
    totalBefore += before;
    if (before < MIN_BYTES) {
        totalAfter += before;
        continue;
    }
    const outFile = path.join(tmp, "out.woff2");
    execFileSync("python3", [
        "-m", "fontTools.subset", file,
        `--text-file=${charsetFile}`,
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        `--output-file=${outFile}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const after = (await stat(outFile)).size;
    // 只在确实明显变小时替换，避免把本来就小的字体裁坏
    if (after < before * 0.95) {
        await writeFile(file, await readFile(outFile));
        processed += 1;
    }
    totalAfter += Math.min(before, after);
    console.log(`${(before / 1048576).toFixed(2)}MB -> ${(after / 1048576).toFixed(2)}MB  ${path.relative(FONT_DIR, file)}`);
}

await rm(tmp, { recursive: true, force: true });
console.log(`\n${processed} files subset. Total ${(totalBefore / 1048576).toFixed(1)}MB -> ${(totalAfter / 1048576).toFixed(1)}MB`);
