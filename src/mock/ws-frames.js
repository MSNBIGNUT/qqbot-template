/**
 * 极简 WebSocket 服务端（仅实现测试所需的帧类型）。
 *
 * 为什么要自己写：本项目坚持**零依赖**，而 `ws` 包只是 optionalDependencies。
 * 这里只处理 text / close / ping / pong 四种帧，足够驱动协议测试。
 */

import crypto from "node:crypto";

// WebSocket 握手固定 GUID（与 ws 包 lib/constants.js 完全一致，共 34 字符）
// 注意：不要凭记忆改写这个常量，它决定 Sec-WebSocket-Accept 是否正确。
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(secWebSocketKey) {
  return crypto
    .createHash("sha1")
    .update(secWebSocketKey + WS_GUID)
    .digest("base64");
}

/** 把文本编码成一个未掩码的服务端帧（opcode 0x1） */
export function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

export function encodeClose(code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 0x02]), payload]);
}

/**
 * 流式帧解析器：把 TCP 分片拼回完整帧。
 * @param {(frame: {opcode:number, payload:Buffer}) => void} onFrame
 */
export function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);

  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("帧过大");
        len = Number(big);
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + len) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i % 4];
        }
      }
      buffer = buffer.subarray(offset + len);
      onFrame({ opcode, payload });
    }
  };
}

/** 客户端帧（带掩码），用于测试里扮演客户端 */
export function encodeClientFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
