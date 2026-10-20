/**
 * QQ 开放平台 HTTP 客户端（零依赖，基于 Node 内建 fetch）。
 *
 * 所有路径与鉴权方式**对齐官方 SDK**（@tencent-connect/qqbot-nodejs 1.0.4）：
 *   POST {tokenBase}/app/getAppAccessToken         body: {appId, clientSecret}
 *   GET  {apiBase}/gateway                          → { url }
 *   POST {apiBase}/v2/users/{openid}/messages       单聊
 *   POST {apiBase}/v2/groups/{group_openid}/messages 群聊
 *   Authorization: QQBot {access_token}
 *
 * 关键细节（官方实现里踩过的坑，这里保留）：
 *   1. 同一个 msg_id 的多次回复必须用**不同** msg_seq，否则平台判定重复而拒发。
 *   2. access_token 默认 7200s 有效，提前 5 分钟刷新（官方 refreshAheadMs）。
 *   3. 响应可能是 HTML（CDN/网关故障），必须单独识别，不能当 JSON 解析。
 */

const TOKEN_PATH = "/app/getAppAccessToken";
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN = 7200;

export class ApiError extends Error {
  constructor(message, { httpStatus = 0, path = "", bizCode = undefined } = {}) {
    super(message);
    this.name = "ApiError";
    this.httpStatus = httpStatus;
    this.path = path;
    this.bizCode = bizCode;
  }
}

/** 官方 getNextMsgSeq：0..65535，按时序 + 随机避免碰撞 */
export function nextMsgSeq() {
  const timePart = Date.now() % 100_000_000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

export function c2cMessagePath(openid) {
  return `/v2/users/${openid}/messages`;
}

export function groupMessagePath(groupOpenid) {
  return `/v2/groups/${groupOpenid}/messages`;
}

export function groupMembersPath(groupOpenid) {
  return `/v2/groups/${groupOpenid}/members`;
}

export function groupMemberPath(groupOpenid, memberOpenid) {
  return `/v2/groups/${groupOpenid}/members/${memberOpenid}`;
}

/**
 * 富媒体上传路径。发语音/图片/视频/文件都必须先上传拿 file_info，
 * 再用 msg_type=7 发送（对齐官方 /v2/users/{openid}/files）。
 */
export function c2cFileUploadPath(openid) {
  return `/v2/users/${openid}/files`;
}

export function groupFileUploadPath(groupOpenid) {
  return `/v2/groups/${groupOpenid}/files`;
}

/** 官方 file_type 取值 */
export const IMAGE_FILE_TYPE = 1;
export const VIDEO_FILE_TYPE = 2;
/** 语音——QQ 只接受 tencent silk（\x02#!SILK_V3 头） */
export const VOICE_FILE_TYPE = 3;
export const FILE_FILE_TYPE = 4;

export class QQApi {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.clientSecret
   * @param {string} opts.apiBase
   * @param {string} opts.tokenBase
   * @param {object} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts) {
    this.appId = opts.appId;
    this.clientSecret = opts.clientSecret;
    this.apiBase = String(opts.apiBase).replace(/\/+$/, "");
    this.tokenBase = String(opts.tokenBase).replace(/\/+$/, "");
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;

    /** @type {{token: string, expiresAt: number}|null} */
    this._cache = null;
    this._inflight = null;
  }

  /** 清空 token 缓存（收到 4004 / 401 时调用） */
  clearTokenCache() {
    this._cache = null;
  }

  /** 取 access_token（带缓存 + 单飞，避免并发重复请求） */
  async getAccessToken() {
    const cached = this._cache;
    if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_AHEAD_MS) {
      return cached.token;
    }
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
      try {
        return await this._fetchToken();
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  async _fetchToken() {
    const url = `${this.tokenBase}${TOKEN_PATH}`;
    const res = await this._raw(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
    });

    const data = await this._parse(res, TOKEN_PATH, { allowHtmlError: true });
    if (!data?.access_token) {
      throw new ApiError(`取 access_token 失败：${JSON.stringify(data)}`, {
        httpStatus: res.status,
        path: TOKEN_PATH,
      });
    }
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : DEFAULT_EXPIRES_IN;
    this._cache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    this.logger?.debug?.(`token 已缓存，${expiresIn}s 后过期`);
    return this._cache.token;
  }

  /** 取 WebSocket 网关地址 */
  async getGatewayUrl() {
    const token = await this.getAccessToken();
    const data = await this.request(token, "GET", "/gateway");
    if (!data?.url) throw new ApiError("网关地址响应缺少 url 字段", { path: "/gateway" });
    return data.url;
  }

  /**
   * 回复单聊/群聊消息。
   * @param {'c2c'|'group'} scope
   * @param {string} targetId 单聊为 user_openid，群聊为 group_openid
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.msgId] 被动回复必须带（回复哪条）
   * @param {number} [opts.msgSeq] 同一 msgId 多次回复需递变
   * @param {boolean} [opts.markdown] 需要 markdown 权限
   */
  async sendMessage(scope, targetId, text, opts = {}) {
    const token = await this.getAccessToken();
    const path = scope === "group" ? groupMessagePath(targetId) : c2cMessagePath(targetId);
    const body = buildMessageBody(text, opts);
    return this.request(token, "POST", path, body);
  }

  /**
   * 主动发送消息（不带 msg_id）——用于"自己找话说"。
   *
   * ⚠️ 平台约束：QQ 对主动消息有严格配额，且用户可在机器人资料卡关闭推送。
   * 一旦用户关闭，接口会返回错误（如 C2C_MSG_REJECT 事件），必须停发而不是重试。
   */
  async sendProactiveMessage(scope, targetId, text) {
    const token = await this.getAccessToken();
    const path = scope === "group" ? groupMessagePath(targetId) : c2cMessagePath(targetId);
    return this.request(token, "POST", path, { content: text, msg_type: 0, msg_seq: nextMsgSeq() });
  }

  /**
   * 通用：把 base64 富媒体上传到单聊或群聊，返回平台给的 file_info。
   *
   * ⚠️ 平台未开通「富媒体消息」权限时会以非 0 bizCode 报错。调用方必须捕获并
   * 降级为文字，绝不要重试刷屏——那只会把配额烧光。
   *
   * @param {'c2c'|'group'} scope
   * @param {string} targetId 单聊为 user_openid，群聊为 group_openid
   */
  async uploadMedia(scope, targetId, fileDataBase64, fileType, { timeoutMs = 30000 } = {}) {
    const token = await this.getAccessToken();
    const isGroup = scope === "group";
    const body = isGroup
      ? buildFileUploadBody({ groupOpenid: targetId, fileDataBase64, fileType })
      : buildFileUploadBody({ openid: targetId, fileDataBase64, fileType });
    const path = isGroup ? groupFileUploadPath(targetId) : c2cFileUploadPath(targetId);
    const data = await this.request(token, "POST", path, body, { timeoutMs });
    return data?.file_info ?? data?.data?.file_info ?? null;
  }

  /**
   * 通用：发一条富媒体消息（msg_type=7）。
   * 传 msgId 即为被动回复（跟一条用户消息），不传则为主动消息（受配额限制）。
   */
  async sendMedia(scope, targetId, fileInfo, { msgId, msgSeq } = {}) {
    const token = await this.getAccessToken();
    const body = buildVoiceMessageBody({ fileInfo, msgId, msgSeq });
    const path = scope === "group" ? groupMessagePath(targetId) : c2cMessagePath(targetId);
    return this.request(token, "POST", path, body);
  }

  /** 上传富媒体到单聊（uploadMedia 的薄封装，保留原签名） */
  async uploadC2CFile(openid, fileDataBase64, fileType, opts = {}) {
    return this.uploadMedia("c2c", openid, fileDataBase64, fileType, opts);
  }

  /** 发一条单聊语音（sendMedia 的薄封装，保留原签名） */
  async sendC2CVoice(openid, fileInfo, opts = {}) {
    return this.sendMedia("c2c", openid, fileInfo, opts);
  }

  /**
   * 取群成员列表（只读 GET）。用于把回复里的「@名字」解析成真实 @。
   *
   * 平台返回形状不统一，这里做了兼容：
   *   - 列表可能在 data.members / data.data / data.items，或是裸数组；
   *   - 分页游标可能叫 next_token / nextToken / marker。
   * 最多翻 maxPages 页，避免失控；每页用 start_index 带上游标。
   *
   * @param {string} groupOpenid
   * @param {{maxPages?: number}} [opts]
   * @returns {Promise<Array<object>>} 成员数组（元素含 member_openid/username/member_role）
   */
  async getGroupMembers(groupOpenid, { maxPages = 3 } = {}) {
    const token = await this.getAccessToken();
    const base = groupMembersPath(groupOpenid);
    /** @type {Array<object>} */
    let all = [];
    let cursor = null;

    for (let page = 0; page < maxPages; page += 1) {
      const path = cursor ? `${base}?start_index=${encodeURIComponent(cursor)}` : base;
      const data = await this.request(token, "GET", path);
      all = all.concat(extractMemberList(data));
      cursor = extractNextCursor(data);
      if (!cursor) break;
    }
    return all;
  }

  /** 取单个群成员信息（只读 GET） */
  async getGroupMember(groupOpenid, memberOpenid) {
    const token = await this.getAccessToken();
    return this.request(token, "GET", groupMemberPath(groupOpenid, memberOpenid));
  }

  /** 通用请求：自动带鉴权头、超时、HTML 识别、错误结构化 */
  async request(token, method, path, body, { timeoutMs = 30000 } = {}) {
    const url = `${this.apiBase}${path}`;
    const headers = {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
    };
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this._raw(url, init, path);
    return this._parse(res, path);
  }

  async _raw(url, init, path = "") {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      const name = err?.name === "TimeoutError" || err?.name === "AbortError" ? "超时" : "网络错误";
      throw new ApiError(`${name} [${path || url}]：${err?.message ?? err}`, { path });
    }
  }

  async _parse(res, path, { allowHtmlError = false } = {}) {
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw new ApiError(`读取响应失败 [${path}]：${err?.message}`, {
        httpStatus: res.status,
        path,
      });
    }

    const contentType = res.headers?.get?.("content-type") ?? "";
    const looksHtml = contentType.includes("text/html") || text.trimStart().startsWith("<");

    if (looksHtml) {
      if (res.ok && allowHtmlError) {
        throw new ApiError(`服务端返回了非 JSON 响应（${path}）`, {
          httpStatus: res.status,
          path,
        });
      }
      throw new ApiError(
        res.status === 429
          ? `请求过于频繁，已被限流（${path}）`
          : `开放平台返回非 JSON 响应 HTTP ${res.status}（${path}），可能临时故障`,
        { httpStatus: res.status, path },
      );
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(`响应不是合法 JSON（${path}）：${text.slice(0, 200)}`, {
          httpStatus: res.status,
          path,
        });
      }
    }

    if (!res.ok) {
      const bizCode = data?.code ?? data?.err_code;
      throw new ApiError(
        `API 错误 [${path}]：${data?.message ?? text.slice(0, 200) ?? res.status}`,
        { httpStatus: res.status, path, bizCode },
      );
    }
    return data;
  }
}

/**
 * 构造消息体。对齐官方 buildMessageBody：
 *   markdown 权限 → { markdown:{content}, msg_type:2, msg_seq }
 *   否则          → { content, msg_type:0, msg_seq }
 */
export function buildMessageBody(text, { msgId, msgSeq, markdown = false } = {}) {
  const seq = Number.isFinite(msgSeq) ? msgSeq : nextMsgSeq();
  const body = markdown
    ? { markdown: { content: text }, msg_type: 2, msg_seq: seq }
    : { content: text, msg_type: 0, msg_seq: seq };
  if (msgId) body.msg_id = msgId;
  return body;
}

/**
 * 构造富媒体上传体。对齐官方：
 *   { file_data: <base64>, file_type, srv_send_msg: false, openid|group_openid }
 *
 * `srv_send_msg:false` 是关键——它让平台只返回 file_info 而不立即发消息，
 * 这样我们才能自己决定用 msg_type=7 在什么时候发。
 */
export function buildFileUploadBody({ openid, groupOpenid, fileDataBase64, fileType }) {
  const body = {
    file_data: fileDataBase64,
    file_type: fileType,
    srv_send_msg: false,
  };
  if (openid) body.openid = openid;
  if (groupOpenid) body.group_openid = groupOpenid;
  return body;
}

/**
 * 构造语音消息体：msg_type=7 + media.file_info。
 * 主动发送时不带 msg_id（此时不写该字段，而不是塞 undefined）。
 */
export function buildVoiceMessageBody({ fileInfo, msgId, msgSeq }) {
  const seq = Number.isFinite(msgSeq) ? msgSeq : nextMsgSeq();
  const body = { media: { file_info: fileInfo }, msg_type: 7, msg_seq: seq };
  if (msgId) body.msg_id = msgId;
  return body;
}

/**
 * 从成员列表响应里提取数组成员。
 * 兼容 {members:[...]} / {data:[...]} / {items:[...]} / 裸数组。
 */
function extractMemberList(data) {
  const arr = Array.isArray(data)
    ? data
    : data?.members ?? data?.data ?? data?.items;
  return Array.isArray(arr) ? arr : [];
}

/** 从成员列表响应里提取分页游标，兼容 next_token / nextToken / marker */
function extractNextCursor(data) {
  const c = data?.next_token ?? data?.nextToken ?? data?.marker;
  return c == null || c === "" ? null : c;
}
