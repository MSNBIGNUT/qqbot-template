# 接入 QQ 小号（OneBot / NapCat）—— 操作手册

> 2026-10-20 起支持。原来是 **QQ 官方机器人 API**（`O鲸鲸` 那个），现在可以换成
> **用你自己的 QQ 小号登录**，经 NapCat / Lagrange 走 OneBot v11。

---

## 一、为什么值得换

官方机器人 API 拿不到的东西，接小号**全都有**：

| 能力 | 官方 API | 小号（OneBot） |
|---|---|---|
| 群名称 | ❌ 只能手动命名 | ✅ `get_group_list` 直接给 |
| 群成员列表 | ❌ 11253 无权限 | ✅ `get_group_member_list` |
| 成员昵称 | ⚠️ 时给时不给 | ✅ 全都有，还带群名片 |
| 群消息触发 | ⚠️ 要 @ 或喊名字 | ✅ **全量可见**（能按内容判断该不该接）|
| 加群限制 | ❌ 群主不是管理员就加不了 | ✅ 像普通人一样被拉进去 |
| 语音/图片 | ✅ | ✅ |
| 头像 | ❌ | ✅ |

**风险**：腾讯禁止第三方客户端。**用小号 + 隔离环境**是最优解。

---

## 二、切换开关

```bash
# .env
QQ_PROTOCOL=onebot          # official（默认）/ onebot

ONEBOT_WS_URL=ws://127.0.0.1:3001        # NapCat 的 WS 地址
ONEBOT_HTTP_URL=http://127.0.0.1:3000    # NapCat 的 HTTP 动作地址
ONEBOT_TOKEN=               # 设了就填，没设留空
ONEBOT_SELF_IDS=            # 小号的 QQ 号（可留空，会从 lifecycle 事件自动拿到）
```

**官方模式不受影响** —— 随时把 `QQ_PROTOCOL` 改回 `official` 就切回来，两套代码并存。

---

## 三、准备清单

### ① 小号

| 项 | 建议 |
|---|---|
| 使用历史 | **至少 1–3 个月**，越新越容易被风控 |
| 绑定 | 绑手机，最好实名过 |
| 聊天记录 | 有正常聊天/群/好友 —— 空白号最可疑 |
| **不要** | 用主号；或在这个号上放支付/重要账号 |

### ② 一个能进的测试群

**自己建一个群**（3–5 人），把小号拉进去。先在小范围跑几天。

出问题（复读、刷屏、错发）只影响测试群，不会社死。

### ③ 运行环境

**推荐 Docker**（和主号的 QQ 完全隔离）：

```bash
docker run -d --name napcat \
  -p 3000:3000 -p 3001:3001 \
  -v ./napcat-data:/app/napcat/config \
  mlikiowa/napcat-docker:latest
```

然后打开 `http://127.0.0.1:3000/webui` 扫码登录**小号**。

**本机版**（不推荐，会和主号抢同一个 QQ 客户端）：

```powershell
# 需要已安装 QQ NT
# 从 https://github.com/NapNeko/NapCatQQ/releases 下载 NapCat-win-x64.zip
```

### ④ 网络

- **固定 IP** 最好（频繁换 IP 会触发风控）
- 不要用免费代理/VPN 跳来跳去

---

## 四、NapCat 配置要点

在 WebUI 里配置 **OneBot v11** 的两个地址：

| 项 | 值 |
|---|---|
| WebSocket 服务端 | 开，端口 `3001` |
| HTTP 服务端 | 开，端口 `3000` |
| access_token | 设一个（然后填到 `ONEBOT_TOKEN`）|

**注意端口要和我们 `.env` 里写的一致。**

---

## 五、不装 NapCat 也能测

代码里带了一个**假的 OneBot 服务端**，可以在**完全不碰真 QQ** 的情况下端到端验证：

```js
import { MockOneBotServer } from './src/qq/onebot/mock-server.js'
import { OneBotClient } from './src/qq/onebot/client.js'

const srv = await new MockOneBotServer({ groups: ['测试群'] }).start()
const client = new OneBotClient({ wsUrl: srv.wsUrl, httpUrl: srv.httpUrl })
client.on('message', (m) => console.log(m))
client.start()
await client.ready(5000)

// 模拟群里有人说话
srv.pushGroupMessage({ groupId: 1001, userId: 11111, text: '帮我画只猫' })

// 看她回了什么
await new Promise((r) => setTimeout(r, 500))
console.log(srv.sentMessages)
```

**建议顺序**：先用 mock 把全流程跑通 → 再装 NapCat 登录小号。

---

## 六、代码结构

```
src/qq/onebot/
  event.js        OneBot 事件 → 内部 msg（纯函数，最好测）
  client.js       WS 收事件 + HTTP 发动作（零依赖，用 Node 内置 WebSocket）
  api-adapter.js  让 OneBot 冒充官方 QQApi（engine 一行都不用改）
  gateway.js      接口对齐官方 QQGateway（main.js 只选哪个）
  mock-server.js  假服务端（含极简 WS 实现），用于无 QQ 测试
```

**关键设计**：`api-adapter.js` 把官方 API 的「先 upload 再 send」语义
映射成 OneBot 的「一段 base64 直接发」—— 所以 **engine / 人格 / 所有技能
完全不知道走的是哪套协议**。

---

## 七、出问题时

| 现象 | 先看 |
|---|---|
| 连不上 | NapCat 在跑吗？端口/令牌对吗？`ONEBOT_WS_URL` 带 `/` 了吗 |
| 收到消息但没回 | `live.log` 里有没有 `收到 c2c/group 消息`；有的话是触发规则问题 |
| 回了但没发出去 | `live.err` 里的 `OneBotApiError`，看 retcode |
| 重复回复 | 检查是不是开了两条 WS（`client` 没复用）|
| 群里不理 | OneBot 模式下推荐 `QQ_GROUP_TRIGGER=all` 或 `wake` |

---

## 八、回退

```bash
QQ_PROTOCOL=official
```

**官方机器人（O鲸鲸）一直都在**，改回来就恢复，不丢任何记忆和数据。
