/**
 * 常驻 RVC worker 的 Node 侧客户端。
 *
 * 一个进程只启动一次（第一次用到时懒启动），之后每句语音只走 stdin/stdout
 * 的 JSON 行协议。模型、RMVPE、154MB faiss index 都留在 Python 进程里，
 * 避免每句话都付 20~30 秒的冷启动。
 *
 * 失败策略：worker 启动失败/超时/崩溃都返回 `{ok:false}`，由 tts.js 降级成
 * 纯 edge-tts；下一次请求会自动重新拉起 worker。
 */

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

/** <repo>/tools/rvc_worker.py */
export function defaultWorkerScript() {
  return path.join(import.meta.dirname, "..", "..", "tools", "rvc_worker.py");
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60000;

function signatureOf(rvc) {
  return JSON.stringify([
    rvc.python,
    rvc.script,
    rvc.model,
    rvc.index,
    rvc.key,
    rvc.indexRate,
    rvc.protect,
    rvc.rmsMixRate,
    rvc.f0Method,
    rvc.device,
    rvc.root,
  ]);
}

export class RvcWorker {
  constructor({ rvc, env = {}, spawnImpl = nodeSpawn, logger = null, script = defaultWorkerScript() }) {
    this.rvc = rvc;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.script = script;
    this.child = null;
    this.ready = false;
    this.readyPromise = null;
    this.device = null;
    this.pending = null;
    this.chain = Promise.resolve();
    this.stderr = "";
    this.disposed = false;
    this.startTimer = null;
  }

  #args() {
    return [
      this.script,
      "--convert-script",
      this.rvc.script,
      "--model",
      this.rvc.model,
      "--index",
      this.rvc.index || "",
      "--key",
      String(this.rvc.key),
      "--index-rate",
      String(this.rvc.indexRate),
      "--protect",
      String(this.rvc.protect),
      "--rms-mix-rate",
      String(this.rvc.rmsMixRate),
      "--f0-method",
      this.rvc.f0Method,
      "--device",
      this.rvc.device,
    ];
  }

  /** 启动并等到 ready。重复调用复用同一个 Promise。 */
  start() {
    if (this.disposed) return Promise.reject(new Error("worker 已销毁"));
    if (this.ready) return Promise.resolve(this);
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(this.rvc.python, this.#args(), {
          windowsHide: true,
          env: { ...process.env, ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        this.logger?.warn?.(`[rvc-worker] 启动失败：${err?.message ?? err}`);
        reject(err);
        return;
      }
      this.child = child;
      // 不把 worker 当成「必须等它结束」的句柄：否则测试/脚本跑完会被
      // 常驻 Python 拖住不退。机器人本身有网关/定时器保持事件循环，
      // unref 不会影响它在运行期间正常收发；退出时由 exit hook 杀掉。
      for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
        try {
          handle?.unref?.();
        } catch {
          /* 某些流没有 unref */
        }
      }
      this.exitHook = () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      process.once("exit", this.exitHook);

      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => this.#onLine(line, resolve, reject));

      child.stderr?.on?.("data", (d) => {
        const text = d.toString();
        this.stderr = `${this.stderr}${text}`.slice(-4000);
        const trimmed = text.trim();
        if (trimmed) this.logger?.debug?.(`[rvc-worker] ${trimmed}`);
      });

      const fail = (err) => {
        if (this.startTimer) {
          clearTimeout(this.startTimer);
          this.startTimer = null;
        }
        if (!this.ready) {
          this.readyPromise = null;
          reject(err);
        }
        this.#settlePending({ ok: false, reason: `RVC worker 中断：${err?.message ?? err}` });
        this.child = null;
        this.ready = false;
        this.readyPromise = null;
      };

      child.on?.("error", fail);
      child.on?.("exit", (code, signal) => {
        if (this.disposed) return;
        fail(new Error(`RVC worker 退出 code=${code}${signal ? ` signal=${signal}` : ""}`));
      });

      this.startTimer = setTimeout(() => {
        const err = new Error(
          `RVC worker 启动超时（>${this.rvc.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS}ms）`,
        );
        this.#kill();
        fail(err);
      }, this.rvc.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    });

    return this.readyPromise;
  }

  #onLine(line, resolveReady, rejectReady) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      // 库日志漏到 stdout 也不该弄崩链路
      this.logger?.debug?.(`[rvc-worker] 忽略非 JSON 输出：${String(line).slice(0, 200)}`);
      return;
    }

    if (payload.ready) {
      if (this.startTimer) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
      this.ready = true;
      this.device = payload.device ?? null;
      this.logger?.info?.(
        `[rvc-worker] 就绪 device=${payload.device} tgt_sr=${payload.tgt_sr} ` +
          `startup=${payload.startup_ms}ms`,
      );
      resolveReady(this);
      return;
    }

    if (!this.pending) return;
    if (payload.ok) {
      this.#settlePending({
        ok: true,
        device: this.device,
        ms: payload.ms,
        sampleRate: payload.sample_rate,
        duration: payload.duration,
      });
    } else {
      this.#settlePending({ ok: false, reason: payload.error || "RVC worker 返回失败" });
    }
  }

  #settlePending(result) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(result);
  }

  #kill() {
    try {
      this.child?.kill?.();
    } catch {
      /* ignore */
    }
  }

  /** 送一次转换请求；串行执行（Python 侧是单线程）。 */
  convert(inPath, outPath, timeoutMs) {
    const run = async () => {
      try {
        await this.start();
      } catch (err) {
        return { ok: false, reason: `RVC worker 启动失败：${err?.message ?? err}` };
      }
      return this.#request(inPath, outPath, timeoutMs);
    };
    const task = this.chain.then(run, run);
    this.chain = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  #request(inPath, outPath, timeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.resolve({ ok: false, reason: "RVC worker 不可写（进程已退出）" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#kill();
        // 杀掉后必须重置 ready，否则下一次请求还会往已死的 stdin 里写
        this.ready = false;
        this.readyPromise = null;
        this.#settlePending({
          ok: false,
          timedOut: true,
          reason: `RVC worker 超时（>${timeoutMs}ms）`,
        });
      }, Math.max(1, Number(timeoutMs) || 30000));

      this.pending = { resolve, timer };
      try {
        this.child.stdin.write(`${JSON.stringify({ in: inPath, out: outPath })}\n`);
      } catch (err) {
        this.#settlePending({ ok: false, reason: `RVC worker 写入失败：${err?.message ?? err}` });
      }
    });
  }

  dispose() {
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.exitHook) process.removeListener("exit", this.exitHook);
    this.exitHook = null;
    this.#settlePending({ ok: false, reason: "RVC worker 已销毁" });
    try {
      this.child?.stdin?.end?.();
    } catch {
      /* ignore */
    }
    this.#kill();
    this.child = null;
    this.ready = false;
    this.readyPromise = null;
  }
}

let _worker = null;

/**
 * 取当前配置对应的单例 worker；配置变了就销毁旧的再建新的。
 * 注入 spawnImpl 仅测试用。
 */
export function getRvcWorker({ rvc, env = {}, spawnImpl, logger = null, script } = {}) {
  const signature = signatureOf(rvc);
  if (_worker && _worker.signature === signature) return _worker;
  _worker?.dispose();
  const worker = new RvcWorker({ rvc, env, spawnImpl: spawnImpl ?? nodeSpawn, logger, script });
  worker.signature = signature;
  _worker = worker;
  return worker;
}

/** 测试/脚本收尾用：销毁全局 worker。 */
export function resetRvcWorker() {
  _worker?.dispose();
  _worker = null;
}
