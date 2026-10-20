/**
 * 打包入口（被 esbuild 打成单文件）。
 *
 * 打包后的 exe 没有"项目目录"概念，所以根目录取 **exe 所在目录**，
 * 保证 .env / data / 记忆文件都落在 exe 旁边。
 */

import path from "node:path";
import process from "node:process";
import { main } from "./main.js";

main({ rootDir: path.dirname(process.execPath) })
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error("启动失败：", err);
    process.exitCode = 1;
  });
