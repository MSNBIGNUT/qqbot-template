/**
 * 构建单文件 exe 的第 2 步：SEA 注入。
 *
 * 原理：
 *   1. node --experimental-sea-config 把 build/bundle.cjs 打成 SEA blob
 *   2. 复制一份 node.exe 作为宿主
 *   3. 用 postject 把 blob 作为 RT_RCDATA 资源写进 PE 文件，并翻转 sentinel fuse
 *      让 Node 启动时知道"我带着脚本"
 *
 * 产物：qqbot-template.exe（约 90MB，自带 Node 运行时，目标机无需安装 Node）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL as pathToFileUrl } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOLS = path.join(ROOT, ".tools");
const BUILD = path.join(ROOT, "build");

/** Node SEA 规定的固定 fuse 字符串（由 postject 用于标记"已注入资源"） */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const RESOURCE_NAME = "NODE_SEA_BLOB";

function run(cmd, args, opts = {}) {
  // 必须 inherit：默认管道模式在受限沙箱下会 EPERM
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}`);
}

async function main() {
  const bundle = path.join(BUILD, "bundle.cjs");
  if (!fs.existsSync(bundle)) {
    throw new Error(`找不到 ${bundle}，请先运行 node scripts/bundle.mjs`);
  }

  // 1) 生成 SEA blob
  const seaConfig = path.join(BUILD, "sea-config.json");
  fs.writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: bundle,
        output: path.join(BUILD, "sea-prep.blob"),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false, // 打包后体积更小，且避免 blob 生成受依赖影响
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("1/3 生成 SEA blob …");
  run(process.execPath, ["--experimental-sea-config", seaConfig]);

  const blob = path.join(BUILD, "sea-prep.blob");
  if (!fs.existsSync(blob)) throw new Error("SEA blob 未生成");
  console.log(`     blob: ${(fs.statSync(blob).size / 1024).toFixed(1)} KB`);

  // 2) 复制宿主 node.exe
  const target = path.join(ROOT, "qqbot-template.exe");
  console.log(`2/3 复制宿主运行时 → ${path.basename(target)} …`);
  // 已被 exe 占用时先删掉旧产物（Windows 不允许覆盖运行中的文件）
  if (fs.existsSync(target)) {
    try {
      fs.rmSync(target, { force: true });
    } catch (err) {
      throw new Error(`无法覆盖 ${target}（可能正在运行）：${err.message}`);
    }
  }
  fs.copyFileSync(process.execPath, target);
  console.log(`     宿主大小: ${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB`);

  // 3) postject 注入
  // 注意：不用它的 CLI —— CLI 依赖 commander；编程接口只依赖 Node 内建模块。
  const postjectApi = path.join(TOOLS, "package", "dist", "api.js");
  if (!fs.existsSync(postjectApi)) {
    throw new Error(`找不到 postject 编程接口：${postjectApi}（应在 .tools/package/dist/api.js）`);
  }
  console.log("3/3 注入 SEA blob（postject 编程接口）…");
  const { inject } = await import(pathToFileUrl(postjectApi).href);
  await inject(target, RESOURCE_NAME, fs.readFileSync(blob), {
    sentinelFuse: SENTINEL_FUSE,
  });

  const size = fs.statSync(target).size;
  console.log(`\n✅ exe 构建完成: ${target}`);
  console.log(`   大小: ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\n冒烟测试:  ${path.basename(target)} --check`);
}

try {
  await main();
} catch (err) {
  console.error(`\n❌ 构建失败: ${err.message}`);
  process.exit(1);
}
