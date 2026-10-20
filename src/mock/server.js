/**
 * 本地模拟 QQ 网关：不需要真实凭证，就能把整条链路跑起来。
 *
 * 它同时模拟：
 *   HTTP  → POST /app/getAppAccessToken、GET /gateway、
 *           POST /v2/users/{openid}/messages、POST /v2/groups/{group}/messages
 *   协议  → WebSocket 升级、op10 HELLO、op2 IDENTIFY、op6 RESUME、op1 心跳、op0 事件下发
 *
 * 用途：
 *   - 无凭证联调（默认 AppID/Secret 随意填）
 *   - 端到端测试：注入消息 → 断言机器人回复内容与发送参数
 *   - 故障演练：模拟 token 接口 5xx、限流、非法凭证
 */

import http from "node:http";
import crypto from "node:crypto";
import { acceptKey, createFrameParser, encodeFrame, encodeClose } from "./ws-frames.js";

export class MockQQServer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.heartbeatInterval] HELLO 里下发的心跳周期
   * @param {number} [opts.tokenExpiresIn]
   * @param {string} [opts.expectedAppId] 校验用的 AppID（不填则不校验）
   * @param {string} [opts.expectedSecret]
   */
  constructor(opts = {}) {
    this.heartbeatInterval = opts.heartbeatInterval ?? 45000;
    this.tokenExpiresIn = opts.tokenExpiresIn ?? 7200;
    this.expectedAppId = opts.expectedAppId ?? "102000001";
    this.expectedSecret = opts.expectedSecret ?? "mock-secret-value";

    this.server = null;
    this.port = 0;
    this.baseUrl = "";

    /** 记录用 */
    this.requests = {
      token: 0,
      gateway: 0,
      sendC2C: 0,
      sendGroup: 0,
      unauthorized: 0,
    };
    this.sentMessages = [];
    this.clientPayloads = [];
    this.openSockets = new Set();

    /** 故障注入 */
    this.faults = { tokenStatus: 0, sendStatus: 0, rejectAuth: false, closeCode: 0 };
    /** 事件序号，递增模拟网关行为 */
    this._seq = 0;
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handleHttp(req, res));
    this.server.on("upgrade", (req, socket, head) => this.#handleUpgrade(req, socket, head));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async stop() {
    for (const s of this.openSockets) {
      try {
        s.destroy();
      } catch {
        /* 忽略 */
      }
    }
    this.openSockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  // ---------------- HTTP ----------------

  #json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  }

  #readBody(req) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
      });
      req.on("end", () => resolve(data));
    });
  }

  async #handleHttp(req, res) {
    const url = new URL(req.url, this.baseUrl);
    const path = url.pathname;

    // 1) 取 access_token
    if (req.method === "POST" && path === "/app/getAppAccessToken") {
      this.requests.token += 1;
      if (this.faults.tokenStatus) {
        return this.#json(res, this.faults.tokenStatus, { message: "模拟故障" });
      }
      const raw = await this.#readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return this.#json(res, 400, { message: "invalid json" });
      }
      if (body.appId !== this.expectedAppId || body.clientSecret !== this.expectedSecret) {
        this.requests.unauthorized += 1;
        return this.#json(res, 401, { code: 100007, message: "appid or secret invalid" });
      }
      return this.#json(res, 200, {
        access_token: `mock-token-${crypto.randomBytes(6).toString("hex")}`,
        expires_in: String(this.tokenExpiresIn),
      });
    }

    // 2) 取网关地址
    if (req.method === "GET" && path === "/gateway") {
      this.requests.gateway += 1;
      if (!this.#authOk(req)) {
        this.requests.unauthorized += 1;
        return this.#json(res, 401, { code: 11244, message: "token invalid" });
      }
      return this.#json(res, 200, { url: `${this.baseUrl.replace("http", "ws")}/websocket` });
    }

    // 3) 发消息
    const c2c = path.match(/^\/v2\/users\/([^/]+)\/messages$/);
    const grp = path.match(/^\/v2\/groups\/([^/]+)\/messages$/);
    if (req.method === "POST" && (c2c || grp)) {
      if (!this.#authOk(req)) {
        this.requests.unauthorized += 1;
        return this.#json(res, 401, { code: 11244, message: "token invalid" });
      }
      if (this.faults.sendStatus) {
        return this.#json(res, this.faults.sendStatus, { code: 22009, message: "模拟发送失败" });
      }
      const raw = await this.#readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return this.#json(res, 400, { message: "invalid json" });
      }
      const scope = c2c ? "c2c" : "group";
      const targetId = decodeURIComponent(c2c ? c2c[1] : grp[1]);
      if (scope === "c2c") this.requests.sendC2C += 1;
      else this.requests.sendGroup += 1;

      const record = { scope, targetId, body, at: Date.now() };
      this.sentMessages.push(record);

      return this.#json(res, 200, {
        id: `msg-${this.sentMessages.length}`,
        timestamp: new Date().toISOString(),
        ext_info: { ref_idx: `ref-${this.sentMessages.length}` },
      });
    }

    return this.#json(res, 404, { message: `no route: ${req.method} ${path}` });
  }

  #authOk(req) {
    if (this.faults.rejectAuth) return false;
    const auth = req.headers.authorization ?? "";
    return /^QQBot\s+\S+/.test(auth);
  }

  // ---------------- WebSocket ----------------

  #handleUpgrade(req, socket, head) {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    const client = {
      socket,
      identified: false,
      intents: 0,
      sessionId: `mock-session-${crypto.randomBytes(4).toString("hex")}`,
      lastSeq: null,
      heartbeats: 0,
      closed: false,
    };
    this.openSockets.add(client);
    this.lastClient = client;

    if (head && head.length) this.#onData(client, head);

    const parse = createFrameParser((frame) => {
      if (frame.opcode === 0x8) {
        client.closed = true;
        try {
          socket.end(encodeClose(1000));
        } catch {
          /* 忽略 */
        }
        this.openSockets.delete(client);
        return;
      }
      if (frame.opcode === 0x9) {
        // ping → pong
        try {
          socket.write(encodeFrame("", 0xa));
        } catch {
          /* 忽略 */
        }
        return;
      }
      if (frame.opcode !== 0x1) return;

      let payload;
      try {
        payload = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        return;
      }
      this.#onClientPayload(client, payload);
    });

    socket.on("data", (chunk) => parse(chunk));
    socket.on("close", () => this.openSockets.delete(client));
    socket.on("error", () => this.openSockets.delete(client));

    // HELLO
    socket.write(
      encodeFrame(
        JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } }),
      ),
    );
  }

  #onData(client, chunk) {
    try {
      client.socket.emit("data", chunk);
    } catch {
      /* 忽略 */
    }
  }

  #sendTo(client, obj) {
    if (!client?.socket || client.closed) return false;
    try {
      client.socket.write(encodeFrame(JSON.stringify(obj)));
      return true;
    } catch {
      return false;
    }
  }

  #onClientPayload(client, payload) {
    this.clientPayloads.push(payload);
    const { op } = payload;

    if (op === 2) {
      // IDENTIFY
      const token = payload?.d?.token ?? "";
      if (!/^QQBot\s+\S+/.test(token)) {
        client.socket.write(encodeClose(4004));
        client.closed = true;
        return;
      }
      client.identified = true;
      client.intents = payload?.d?.intents ?? 0;
      client.lastSeq = 1;
      this.#sendTo(client, {
        op: 0,
        s: 1,
        t: "READY",
        d: {
          version: 1,
          session_id: client.sessionId,
          user: { id: "10001", username: "春禾测试机器人", bot: true },
          shard: [0, 1],
        },
      });
      return;
    }

    if (op === 6) {
      // RESUME
      client.identified = true;
      client.lastSeq = payload?.d?.seq ?? 0;
      this.#sendTo(client, { op: 0, s: client.lastSeq + 1, t: "RESUMED", d: "" });
      return;
    }

    if (op === 1) {
      client.heartbeats += 1;
      this.#sendTo(client, { op: 11 });
    }
  }

  /** 判断是否已有一个完成鉴权的连接 */
  get connectedClients() {
    return [...this.openSockets].filter((c) => c.identified && !c.closed);
  }

  /** 向所有已鉴权连接推送一个事件 */
  pushEvent(type, data) {
    this._seq += 1;
    let delivered = 0;
    for (const client of this.connectedClients) {
      client.lastSeq = this._seq;
      if (this.#sendTo(client, { op: 0, s: this._seq, t: type, d: data })) delivered += 1;
    }
    return delivered;
  }

  /** 构造一条单聊消息事件并推送 */
  pushC2C({ content, openid = "user-openid-1", msgId = `m-${this._seq + 1}` }) {
    return this.pushEvent("C2C_MESSAGE_CREATE", {
      id: msgId,
      content,
      timestamp: new Date().toISOString(),
      author: { user_openid: openid },
    });
  }

  /** 构造一条群内 @机器人 消息并推送 */
  pushGroupAt({
    content,
    openid = "member-openid-1",
    groupOpenid = "group-openid-1",
    msgId = `m-${this._seq + 1}`,
  }) {
    return this.pushEvent("GROUP_AT_MESSAGE_CREATE", {
      id: msgId,
      content,
      timestamp: new Date().toISOString(),
      group_openid: groupOpenid,
      author: { member_openid: openid, username: "群友" },
    });
  }

  /** 强制断开所有连接（模拟网络抖动） */
  dropConnections(code = 1006) {
    for (const client of [...this.openSockets]) {
      try {
        client.socket.destroy();
      } catch {
        /* 忽略 */
      }
      this.openSockets.delete(client);
    }
    return code;
  }
}
