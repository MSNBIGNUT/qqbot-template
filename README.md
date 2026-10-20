# QQ 机器人模板 —— 让你的角色住进 QQ

> 一句话：填两个 key（QQ AppID/Secret + 任意 OpenAI 兼容 API Key），
> 你就有了一个能聊天、能记事、能发语音、能发表情包、能画图的 QQ 机器人。

这是一个**可开源发布的通用模板**。它来自一个真实跑了大半年的私人 QQ 机器人
（「春禾」），把人格、素材、数据和密钥全部剥离后留下可复用的骨架：
659 项测试、零运行时依赖、官方协议实现、人格可替换。

- 示例人格「春禾」保留在 `src/persona/chunhe.js`（看它怎么写的）
- 通用人格「小助手」在 `src/persona/default.js`（直接拿来改成你的角色）
- 你自己的角色：复制一个文件，改提示词，设 `PERSONA` 指过去

---

## 这个模板能做什么

### 核心：不配额外服务就能用

| 能力 | 说明 |
| --- | --- |
| **对话** | OpenAI 兼容接口（DeepSeek / 智谱 / Moonshot / Ollama…），也自带无需 key 的本地规则兜底 |
| **记忆** | 会话记忆落盘，重启不忘；私聊/群聊跨场景共享；「主人」会话单独放大窗口 |
| **群聊触发** | `mention`（只回 @）/ `wake`（喊名字就应答）/ `all`；未触发的消息也能进上下文缓冲 |
| **多段回复** | 按语义拆成 1~3 条，中间有停顿，像真人分几口气说话 |
| **去重 / 限流 / 白名单** | QQ 会重推消息；这些都内建，防止刷屏和额度被陌生人消耗 |
| **AI 明示标识** | 平台合规要求；`none` / `prefix` / `suffix` 三档可配 |
| **文件识别** | Word / Excel / PPT / 旧版 Office / WPS / CSV / 代码 / 文本，零依赖自解析 |
| **本地模拟网关** | 没凭证也能 `npm run smoke` 端到端跑通一条消息 |
| **人格抽象** | `PERSONA` 一行切换；人格文件只负责“像谁”，引擎负责“怎么活” |

### 可选：配了对应服务才启用

| 能力 | 需要什么 |
| --- | --- |
| **图片理解** | OpenAI 兼容的多模态模型（`MODEL_VISION=true`） |
| **画图** | 火山方舟 ARK 生图（`ARK_API_KEY`）；可配角色参考图锁定形象 |
| **表情包** | `assets/stickers/` 放图；模型通过 `send_sticker` 工具发 |
| **语音回复** | Python + `edge-tts` + `pysilk`（`.voice-venv`）；群语音需平台开通 |
| **唱歌** | 曲库 + RVC 音色模型（不随模板分发，需自备） |
| **定时提醒** | 内建，无需额外服务（占平台主动消息配额） |
| **主动消息** | 内建，默认关（`QQ_PROACTIVE`），有每日上限和静默时段 |
| **跨场景待办** | 内建：私聊下令、群里执行，失败会如实回报 |
| **远程控制电脑** | 内建但默认关；`REMOTE_ENABLED=true` + 私聊解锁，危险命令二次确认 |
| **双引擎切换** | 内建但需要你自己的切换脚本（`BRAIN_SWITCH_SCRIPT`） |

---

## 5 分钟跑起来

### 第 1 步：在 QQ 开放平台建号

<https://q.qq.com/qqbot/open> —— 个人主体入驻（邮箱 + 实名管理员），创建机器人，
拿到 **AppID / AppSecret**。

> 先玩沙箱：沙箱群成员 ≤ 20 人，且你必须是群主/管理员。
> 新机器人**默认启用 IP 白名单**，真实连接前要在平台填上你的出口 IP。

### 第 2 步：填 `.env`

```bash
cp .env.example .env
```

最少填这四行：

```ini
QQ_APP_ID=你的AppID
QQ_APP_SECRET=你的AppSecret
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_API_KEY=sk-你的key
```

模型不填也能跑：会退化成「本地规则模式」（算数学、打招呼、回答自己是谁），
适合先验证链路，不适合真聊天。

### 第 3 步：启动

```bash
npm install          # 只有一个可选依赖 ws（不装也能跑源码，装了更稳）
node src/main.js --check   # 配置自检：缺什么逐条列出，退出码 2 = 未就绪
npm start            # 连接真实 QQ
```

无凭证先验证链路：

```bash
npm run smoke        # 本地模拟网关，收一条、回一条、打印结果后退出
```

Windows 用户可以直接双击 `start-bot.bat`：它会优先找 DSH 自带的 Node，
找不到再用 PATH 里的；启动失败会把原因打出来，不会一闪而过。

---

## 换一个角色

### 换名字：`BOT_NAME`

```ini
BOT_NAME=团子
```

它会影响提示词里的自称，以及引擎/媒体模块里那些会发给用户的文案。
**人格文件里的名字优先级更高**：`default.js` 导出 `PERSONA_NAME = "小助手"`，
没显式配 `BOT_NAME` 时就用它。

### 换人格：`PERSONA`

```ini
PERSONA=chunhe          # 示例人格（默认）
PERSONA=default         # 通用助手「小助手」，中性、开箱即用
PERSONA=./my-bot.js     # 你自己的文件，路径相对项目根目录
```

加载器在 `src/persona/index.js`：

- **默认 `chunhe`**，什么都不改时行为和原项目完全一致；
- 文件不存在 / 导出不全 → **明确报错并列出可用人格**，不会静默降级；
- 人格模块接口与 `chunhe.js` 完全一致（`createPersona`、`buildSystemPrompt`、
  `composeReminderText` 等，见文件头注释）。

### 写你自己的角色（最省事的路径）

1. 复制 `src/persona/default.js` 为 `src/persona/my-bot.js`；
2. 改 `CHUNHE_SYSTEM_PROMPT` 里的【身份与气质】（名字、性格、说话方式），
   **别动**这几节：`【说人话 · 去 AI 味】`、`【温度】`、`【边界与拒绝】`、
   `【骚扰分级响应】`、`【说话人归属】`、`【画图】`——那些是踩过坑的行为层；
3. 改 `PERSONA_NAME`；
4. `.env` 里设 `PERSONA=./src/persona/my-bot.js`；
5. **同步改 `QQ_WAKE_NAMES`**：唤名和人格是两件事，不会自动跟着换。
   群里喊新名字不响应，多半是这里没改。

> `CHUNHE_SYSTEM_PROMPT` 这个名字是历史遗留，为了接口兼容没改。
> 换人格不需要改调用方，也不需要改导出名。

---

## 配置总览

完整清单见 [`.env.example`](.env.example)（每一项都有中文注释）。最常改的 10 个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QQ_APP_ID` / `QQ_APP_SECRET` | 无 | 机器人凭证（必需） |
| `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_NAME` | 空 | OpenAI 兼容模型；不填走本地规则 |
| `PERSONA` | `chunhe` | 人格模块：`chunhe` / `default` / `./my-bot.js` |
| `BOT_NAME` | `春禾` | 机器人自称（人格文件里的名字优先） |
| `QQ_WAKE_NAMES` | `春禾` | 群里喊哪个名字算叫到它 |
| `QQ_GROUP_TRIGGER` | `mention` | `mention` / `wake` / `all` |
| `QQ_ALLOW_FROM` | 空 | 用户 openid 白名单，**留空 = 谁都能用你的额度** |
| `AI_LABEL_STYLE` | `none` | `none` / `prefix` / `suffix`（合规标识） |
| `MODEL_VISION` | `false` | 图片理解开关 |
| `QQ_REMINDERS` / `QQ_PROACTIVE` | `true` / `false` | 提醒 / 主动消息 |

---

## 技能开关（核心 vs 可选）

| 开关 | 关掉后 | 打开要额外做什么 |
| --- | --- | --- |
| `QQ_GROUP_TRIGGER` | 只回 @ | `wake` 需要群主开「接收全量消息」，否则普通发言到不了机器人 |
| `MODEL_VISION` | 看不到图，会如实说 | 模型必须支持图片输入 |
| `IMAGE_GEN_ENABLED` | 不能画图 | 填 `ARK_API_KEY`（火山方舟），可选 `ARK_IMAGE_MODEL` |
| `STICKER_ENABLED` | 不发表情包 | 往 `assets/stickers/` 放图（jpg/png/webp/gif） |
| `TTS_ENABLED` | 只发文字 | Python venv + `edge-tts` + `pysilk`，跑 `node scripts/voice-selftest.mjs` 自检 |
| `SING_ENABLED` | 不能唱歌 | 曲库 + RVC 音色；模型文件需自备，不随模板分发 |
| `REMOTE_ENABLED` | 不能反向控制电脑 | 设 `REMOTE_PASS_HASH`，私聊里解锁；危险命令要二次确认 |
| `QQ_PROACTIVE` | 不会主动开口 | 占平台主动消息配额，有每日上限与静默时段 |
| `QQ_REMINDERS` | 不能定时提醒 | 内建，无需额外服务 |

---

## 部署

### Windows：一键脚本

双击 `start-bot.bat`（源码模式，不依赖打包 exe）。窗口别关，关掉就下线；
`Ctrl+C` 停机会先把记忆落盘。

> `scripts/build-exe.mjs` 能把项目打成 90MB 单文件 exe（自带 Node）。
> 但注入 SEA blob 会破坏数字签名：**启用了 Smart App Control / Device Guard 的机器会拒绝运行**。
> 长期在线推荐源码运行。

### Linux：systemd

```ini
# /etc/systemd/system/qqbot.service
[Unit]
Description=QQ Bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/qqbot
ExecStart=/usr/bin/node src/main.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/qqbot/.env
# 记忆文件写在这里，确保有权限
# Environment=QQ_MEMORY_FILE=data/memory.json

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qqbot
journalctl -u qqbot -f
```

### 反代 / 公网入口：一般不需要

QQ 官方的 WebSocket 网关是**客户端主动外连**：不需要公网 HTTPS、不需要备案域名、
不需要开端口，普通云主机或家用常开设备即可（只要有固定出口 IP 填进平台白名单）。

只有当你自己加了 Web 面板/回调才需要反代；那时记得：
**`.env` 和 `data/` 不要暴露到 Web 根目录**。

### 上真实 QQ 之前必须由你完成的事

1. 开放平台注册、创建机器人，拿 AppID/AppSecret；
2. 沙箱自测（群成员 ≤ 20，你是群主/管理员）；
3. **填 IP 白名单**（不填不能提审上线）；
4. 若下发链接，域名需 ICP 备案后报备；
5. 提审 + 官方自测报告，审核通过后手动上线。

---

## 它踩过的坑（挑最有教育意义的几条）

1. **QQ 不渲染 LaTeX**。模型默认吐 `\(\alpha\)`，用户看到的是乱码。
   提示词里禁止 + `src/util/format.js` 兜底转换，双保险。
2. **图片直链会被模型服务拒**。多模态接口要求把图片下载成 base64 内联，
   直链会 400（服务端拉不到那张图）。`collectImageParts` 就是为这个写的。
3. **`import.meta.url` 是 URL 编码的**。目录名含中文时 `.env` 会找不到，
   表现为“静默降级成本地规则模式”，极难查。用 `import.meta.dirname`，别手工拼 pathname。
4. **mock 冒烟跑去打真沙箱**。只改 `apiBase` 不够，`resolveApiBase()` 会在
   `sandbox=true` 时改回沙箱地址；mock 模式必须同时关掉 sandbox。
5. **“必须塞句名字才会回应”**。模型会把唤名当成待讨论的内容，生成“春禾觉得…”这种
   第三人称回答。命中唤名后要先剥掉再送模型。
6. **RVC 48kHz 重训无效**。交付链路上限只有 12kHz，重训再高也没用；
   真正解决靠常驻 worker + 情绪韵律层，不是靠更大的模型。
7. **人设会替自己编来历**。模型会把“提示词里的设定”讲成“我记得的事”；
   诚实条款必须明确“不编造记住的东西”，且来历要么给真的，要么不给。
8. **先答应再失联**。“这就去”“已经发了”这类话，只能在拿到系统回执之后说。
   提示词里为此单独写了一节，引擎也会在无回执时改写。
9. **新机器人默认 IP 白名单**。忘了填的表现是所有连接静默失败，错误信息很少。

---

## 已验证的接口（照抄官方 SDK，非推测）

| 用途 | 方法与路径 |
| --- | --- |
| 取访问凭证 | `POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` → `access_token`（默认 7200s） |
| 取网关地址 | `GET {apiBase}/gateway` → `{ url }` |
| 单聊发消息 | `POST {apiBase}/v2/users/{user_openid}/messages` |
| 群聊发消息 | `POST {apiBase}/v2/groups/{group_openid}/messages` |
| 鉴权头 | `Authorization: QQBot {access_token}` |

WebSocket 网关协议：

| 场景 | 报文 |
| --- | --- |
| 连接后收到 | `op 10 HELLO { heartbeat_interval }` |
| 首次鉴权 | `op 2 IDENTIFY { token: "QQBot xxx", intents, shard: [0,1] }` |
| 断线恢复 | `op 6 RESUME { token, session_id, seq }` |
| 心跳 | `op 1 HEARTBEAT { d: 最新 seq }`，服务端回 `op 11 ACK` |
| 事件下发 | `op 0 DISPATCH { t: 事件名, d: 数据, s: 序号 }` |

默认 intents：`1<<0 | 1<<30 | 1<<25 | 1<<26`。
单聊/群消息靠 `GROUP_AND_C2C`；频道消息靠 `PUBLIC_GUILD_MESSAGES`。

---

## 群聊触发与上下文缓冲

| 模式 | 行为 | 适合 |
| --- | --- | --- |
| `mention`（默认） | 只回应 @ 的消息 | 大多数群，最省心 |
| `wake` | @ **或**正文里喊到唤名都回应 | 想让它像群成员一样随时能被叫 |
| `all` | 群里任何消息都回 | 私人小群，否则很扰民 |

- **wake 的前提**：群主必须开启「接收全量消息」，否则平台只推 @ 消息，喊名字不生效。
- **命中尺度**：`春禾`、`春禾？`、`春禾在吗`、`春禾帮我算个题` 命中；
  `今天天气不错` 不命中（避免闲聊时突然插话）。
- **上下文缓冲**：`QQ_GROUP_WATCH=true` 时，未触发的消息也记最近 N 条，
  **不调用模型、不花钱**；被叫到时能接上前面的对话。

---

## 文件识别（实测）

收到文件后自动下载、提取文本，再交给模型。**零依赖**：`.docx/.xlsx/.pptx` 本质是
ZIP + XML，用 Node 内建 `zlib` 自己解包。

| 类别 | 支持 | 提取效果 |
| --- | --- | --- |
| Word | `.docx` `.docm` | 段落 + 表格还原成 `\| 列 \| 列 \|` |
| Excel | `.xlsx` `.xlsm` | 工作表名 + 制表符对齐 + **公式保留** |
| PPT | `.pptx` | 按页分块（`[第 1 页]`） |
| 旧版 Office | `.doc` `.xls` `.ppt` | OLE 复合文档解析 |
| WPS | `.wps` `.et` `.dps` | ZIP 与 OLE 两条路径 |
| CSV / 代码 / 文本 | 30+ 扩展名 | 原文；自动识别 GBK |

实测（真实样本 + 真模型）：`.docx` 能读出季度报告和表格；`.xlsx` 能读出公式
`=SUM(B2:B3)` 并说明“表里没直接给结果，我不替它填”；`.pptx` 能按页复述；
无后缀的 OLE 文件能按魔数判型，读不出来会诚实说读不出来。

**已知读不出来的**：加密文档、Word 域代码、图片/图表里的文字（无 OCR）、RTF（未实现）。

---

## 目录结构

```
qqbot-template/
├── src/
│   ├── main.js                入口：配置 → 人格 → 引擎 → 网关
│   ├── config.js              全部环境变量在这里（含 botName/persona）
│   ├── persona/
│   │   ├── index.js           人格加载器（PERSONA 解析、校验、报错）
│   │   ├── naming.js          运行期「机器人自称」注册表
│   │   ├── chunhe.js          示例人格：春禾（完整功能 + 大量踩坑注释）
│   │   └── default.js         通用人格：小助手（模板，照它改）
│   ├── core/                  引擎、记忆、提醒、待办、主动消息、限流…
│   ├── media/                 画图、表情包、语音、唱歌、文件提取
│   ├── qq/                    官方 API 客户端 + WebSocket 网关
│   ├── mock/                  本地模拟网关（无凭证联调）
│   └── util/                  日志脱敏、格式化
├── test/                      659 项测试
├── scripts/                   开发自检脚本（真实链路/探针，非运行时依赖）
├── docs/                      设计报告（踩坑记录、实测数据）
├── data/                      运行期数据（空目录 + .gitkeep）
├── assets/stickers/           表情包素材（空目录，放你自己的）
├── .env.example               配置模板（中文注释）
├── start-bot.bat              Windows 一键启动
└── package.json
```

---

## 测试与自检

```bash
npm test                              # 659 项：652 通过 / 7 跳过 / 0 失败
node --check src/main.js              # 语法检查
node src/main.js --check              # 配置自检（不连接）
npm run smoke                         # 本地模拟网关端到端冒烟
```

跳过的 7 项是**依赖私有素材/样本**的契约测试（6 项表情库 + 1 项 `_fixtures` 文档样本）：
模板仓库不含这些资产，测试会自动 skip 而不是误报失败。放进你自己的素材后会自动恢复。

真实链路自检脚本（需要 key，可选）：

```bash
node scripts/check-chat.mjs           # 真模型聊一句
node scripts/check-files.mjs          # 真文件识别
node scripts/check-vision.mjs         # 真图片理解
node scripts/check-reminder.mjs       # 真等 20 秒看它主动发消息
```

---

## 授权

MIT，见 [LICENSE](LICENSE)。

QQ、QQ 开放平台是腾讯的商标；本项目与腾讯无隶属关系。
使用前请自行确认符合 QQ 机器人运营规范（尤其是**主动消息**、**AI 明示**、
**隐私**这三块）。
