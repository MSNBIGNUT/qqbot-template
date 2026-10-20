/**
 * 媒体下载：把 QQ 的消息附件下载成 base64 data URL，供支持视觉的模型使用。
 *
 * 为什么必须下载后转 base64（实测结论，不是推测）：
 * 把图片直链直接交给模型接口会返回 400 —— 模型服务端**自己去拉取**这个 URL。
 * 如果那个地址它够不到（内网、鉴权、CDN 限制），就整个请求失败。
 * 实测 base64 方式稳定可用。
 *
 * 安全与稳健性约束：
 *  - 只接受 http/https，拒绝其他协议（避免 file:// 之类被利用）
 *  - 限制大小与超时，避免被超大图拖垮进程
 *  - 只接受图片 MIME，其他类型不下载
 *  - 失败一律返回 null，让上层降级为诚实文案，而不是抛错中断对话
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 15000;
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** 下载任意附件为 Buffer（文件识别用；不是图片也能下） */
export async function fetchFileAsBuffer(url, opts = {}) {
  const {
    maxBytes = 10 * 1024 * 1024,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    logger,
  } = opts;

  if (typeof url !== "string" || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    logger?.warn?.("附件地址无法解析");
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    logger?.warn?.(`拒绝非 http(s) 的附件地址：${parsed.protocol}`);
    return null;
  }

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger?.warn?.(`附件下载失败 HTTP ${res.status}`);
      return null;
    }
    const declared = Number(res.headers?.get?.("content-length") ?? 0);
    if (declared && declared > maxBytes) {
      logger?.warn?.(`附件过大（${(declared / 1024 / 1024).toFixed(1)}MB），跳过`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes || buf.length === 0) return null;
    return { buf, contentType: (res.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase() };
  } catch (err) {
    logger?.warn?.(`附件下载异常：${err?.name === "TimeoutError" ? "超时" : err?.message}`);
    return null;
  }
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.logger]
 * @returns {Promise<string|null>} data URL，失败返回 null
 */
export async function fetchImageAsDataUrl(url, opts = {}) {
  const {
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    logger,
  } = opts;

  if (typeof url !== "string" || url.length === 0) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    logger?.warn?.("图片地址无法解析，跳过视觉处理");
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    logger?.warn?.(`拒绝非 http(s) 的图片地址：${parsed.protocol}`);
    return null;
  }

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) {
      logger?.warn?.(`图片下载失败 HTTP ${res.status}`);
      return null;
    }

    const contentType = (res.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mime = contentType || "image/png";
    if (!ALLOWED_MIME.has(mime)) {
      logger?.warn?.(`不支持的图片类型：${contentType || "(未知)"}`);
      return null;
    }

    // 先看 Content-Length，能省掉一次大文件传输
    const declared = Number(res.headers?.get?.("content-length") ?? 0);
    if (declared && declared > maxBytes) {
      logger?.warn?.(`图片过大（声明 ${(declared / 1024 / 1024).toFixed(1)}MB），跳过视觉处理`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      logger?.warn?.(`图片过大（实际 ${(buf.length / 1024 / 1024).toFixed(1)}MB），跳过视觉处理`);
      return null;
    }
    if (buf.length === 0) {
      logger?.warn?.("图片内容为空，跳过视觉处理");
      return null;
    }

    logger?.debug?.(`图片已获取 ${(buf.length / 1024).toFixed(1)}KB (${mime})`);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "下载超时" : (err?.message ?? String(err));
    logger?.warn?.(`图片下载异常：${reason}`);
    return null;
  }
}
