/**
 * 构建单文件 exe 的第 1 步：用 esbuild 把 src/ 打包成单个 CommonJS 文件。
 *
 * 为什么需要打包：Node 的 SEA（单文件可执行）只能注入**一个**脚本，
 * 且运行时没有真实文件系统，无法 require 同目录的其他模块。
 * 所以必须先把 11 个模块压成一个文件。
 *
 * 不依赖 npm：直接从 registry 取 esbuild 的平台二进制压缩包并解压。
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOLS = path.join(ROOT, ".tools");
const BUILD = path.join(ROOT, "build");

const ESBUILD_VERSION = process.env.ESBUILD_VERSION ?? "0.28.2";
const PLATFORM_PKG = "@esbuild/win32-x64";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
          res.resume();
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", reject);
  });
}

function registryTarball(pkg, version) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F")}`;
    https
      .get(url, { headers: { Accept: "application/json" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const meta = JSON.parse(data);
            const ver = version ?? meta["dist-tags"].latest;
            resolve({ version: ver, tarball: meta.versions[ver].dist.tarball });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(TOOLS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // 1) 取 esbuild 二进制
  const esbuildExe = path.join(TOOLS, "esbuild.exe");
  if (!fs.existsSync(esbuildExe)) {
    console.log(`下载 ${PLATFORM_PKG}（esbuild ${ESBUILD_VERSION}）…`);
    const { tarball, version } = await registryTarball(PLATFORM_PKG, ESBUILD_VERSION);
    console.log(`  tarball: ${tarball}  (v${version})`);
    const tgz = path.join(TOOLS, "esbuild.tgz");
    await download(tarball, tgz);
    console.log(`  已下载 ${(fs.statSync(tgz).size / 1024 / 1024).toFixed(1)} MB，解压中…`);
    execFileSync("tar", ["-xzf", tgz, "-C", TOOLS], { stdio: "inherit" });

    // 平台包结构：package/bin/esbuild.exe
    const candidate = path.join(TOOLS, "package", "bin", "esbuild.exe");
    const alt = path.join(TOOLS, "package", "esbuild.exe");
    const src = fs.existsSync(candidate) ? candidate : alt;
    if (!fs.existsSync(src)) {
      throw new Error(`解压后找不到 esbuild 可执行文件，检查目录: ${path.join(TOOLS, "package")}`);
    }
    fs.copyFileSync(src, esbuildExe);
    fs.rmSync(path.join(TOOLS, "package"), { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
    console.log(`  esbuild 就绪: ${esbuildExe}`);
  } else {
    console.log(`esbuild 已存在: ${esbuildExe}`);
  }

  // 2) 打包
  const outfile = path.join(BUILD, "bundle.cjs");
  console.log("\n打包 src/ → build/bundle.cjs …");
  // 注意：必须用 stdio: "inherit"。默认的管道模式在受限沙箱下会 EPERM。
  const code = spawnSync(
    esbuildExe,
    [
      "src/sea-entry.js",
      "--bundle",
      "--platform=node",
      "--target=node22",
      "--format=cjs",
      "--outfile=" + outfile,
      // ws 只在 Node 缺内建 WebSocket 时才需要；本项目改用内建实现，标记为外部避免打包失败
      "--external:ws",
      // 只替换专属占位符，避免碰坏代码里对 __dirname 的判断
      `--define:__DSH_SRC_DIR__=${JSON.stringify(path.join(ROOT, "src"))}`,
      "--log-level=info",
    ],
    { cwd: ROOT, stdio: "inherit" },
  ).status;

  if (code !== 0) throw new Error(`esbuild 退出码 ${code}`);
  if (!fs.existsSync(outfile)) throw new Error("esbuild 未生成 bundle 文件");

  const size = fs.statSync(outfile).size;
  console.log(`\n✅ bundle 生成: ${outfile}  (${(size / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error("\n❌ 构建失败:", err.message);
  process.exit(1);
});
