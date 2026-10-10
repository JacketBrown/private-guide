# API 密钥与配置更换指南

> 适用项目：私人 AI 导游 App（private-guide-app）
> 更新时间：v1.3 配套
> 一句话结论：**换密钥 / 换模型 / 换服务商，任何情况下都不需要改代码、不需要重新打包。**

---

## 一、先弄清楚：配置分两层，密钥永远在前端摸不到的地方

```
┌─────────────────────────────────────────────┐
│  前端（网页 / 未来 App）                      │
│  只知道"后端地址"，不知道任何密钥              │
└──────────────────┬──────────────────────────┘
                   │ HTTP
┌──────────────────▼──────────────────────────┐
│  后端 server/（Node + Express 中转）          │
│  持有密钥，负责调用 AI / TTS                  │
│                                             │
│  配置三级优先级（后者覆盖前者）：              │
│   1. 内置默认值（server/config.js）           │
│   2. server/.env           ← 初始配置         │
│   3. server/data/config.json ← 运行时热切换   │
└─────────────────────────────────────────────┘
```

- **前端**只管"连哪个后端"（Web 阶段同源自动解决；App 阶段填一次地址即可）。
- **后端**管"用哪家 AI、哪个模型、哪个密钥"——改这里，前端完全无感。
- 密钥明文只存在于服务端（`.env` 或 `data/config.json`），接口对外只返回掩码（如 `sk-pfj****cusb`）。

---

## 二、Web 阶段（现在）：三种换密钥方式

### 方式 1：改 `.env` 后重启（适合首次部署）

```bash
# 编辑 private-guide-app/server/.env
LLM_PROVIDER=taotoken
LLM_API_KEY=sk-你的新密钥
# 可选：LLM_BASE_URL / MODEL_VISION / MODEL_TEXT

# 重启生效
node server/index.js
```

### 方式 2：界面热切换（推荐，无需重启）

1. 打开网页 → 右上角 **齿轮图标（服务设置）**
2. 展开 **「高级：直接修改服务端配置」**
3. 选择服务商（自动带出地址和模型）→ 粘贴新密钥 → **保存到服务端**
4. 点 **「连通性自检」** 确认绿色 ✓

写入的是 `server/data/config.json`，**立即生效、重启后依然有效**。
若服务端设置了 `CONFIG_TOKEN` 环境变量，表单里需要填同样的"修改口令"。

### 方式 3：接口调用（适合脚本 / 远程运维）

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{"provider":"taotoken","apiKey":"sk-新密钥"}'

# 验证（只返回掩码，不会泄露明文）
curl http://localhost:3000/api/config

# 连通性自检
curl -X POST http://localhost:3000/api/config/test
```

安全细节：
- `apiKey` 传**空字符串 = 不修改**，避免误清空。
- 任何响应都不含明文密钥；`data/config.json` 已加入 `.gitignore`，不会被提交。

### 换服务商预设速查

| 服务商 | provider | baseUrl | 默认识别/生成模型 |
|---|---|---|---|
| TaoToken 中转（当前） | `taotoken` | https://api.taotoken.net/v1 | glm-5.3-flash / deepseek-v4-pro |
| 阿里云百炼 | `dashscope` | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-vl-max / qwen-max |
| OpenAI 官方 | `openai` | https://api.openai.com/v1 | gpt-4o / gpt-4o |
| DeepSeek 官方 | `deepseek` | https://api.deepseek.com/v1 | deepseek-vl2 / deepseek-chat |
| 自建代理 | `custom` | 自填（须 OpenAI 兼容，/v1 结尾） | 自填 |

切换后**必须自检一次**（`连通性自检`按钮），确认视觉模型可用——识别功能依赖图片输入，纯文本模型会导致识别失败。

---

## 三、App 阶段（打包后）：三种部署架构怎么选

打包成 App 后，前端跑在手机 WebView 里（`file://` / `capacitor://localhost`），**它自己没有后端**，必须指向一个真实运行中的 server。三种方案：

### 方案 A：云服务器部署后端（推荐，正式发布用）

```
手机 App ──► https://你的域名或IP:3000 ──► AI 服务商
```

- 密钥只在云服务器上，App 里完全没有密钥 → **最安全**。
- 换密钥 = 登录服务器改配置（方式 2/3 均可），用户无感，**不用重新发版**。
- 后端怎么部署：
  1. 买一台云服务器（或轻量应用服务器），安装 Node 18+
  2. 上传 `private-guide-app/server/` 目录，`npm install`
  3. 写好 `.env`，用 pm2 守护：`pm2 start index.js --name guide`
  4. 建议套 Nginx + HTTPS（App 内 `http://` 明文地址在 iOS 上会被 ATS 拦截，**正式版必须 https**）
  5. 设置 `ALLOW_ORIGIN=https://app容器来源`（可先 `*` 调通再收紧）和 `CONFIG_TOKEN`（给配置接口上锁）

### 方案 B：App 内置"服务地址"设置（个人使用 / 演示用）

项目已内置该能力（v1.3）：
- App 首页右上角齿轮 → **服务设置** → 填后端地址（如 `http://192.168.1.8:3000`）→ 测试连接 → 保存。
- 地址存 localStorage，**改地址不需要重新打包**。
- 也可在打包时把固定地址写进 `web/env.js` 的 `BASE_URL`（用户填的地址优先级更高）。
- 局限：后端仍需要你自己开（电脑跑着 / 家里 NAS / 云服务器都行）；手机和后端要么同局域网，要么后端有公网地址。

### 方案 C：把后端打进 App（不推荐，仅了解）

理论上可用 Capacitor 的 NodeJS 移植或改用纯前端直连 AI 服务商。问题：
- 密钥被打进 APK/IPA，**可被解包提取**，等于公开密钥 → 烧钱风险。
- 纯前端直连还受 CORS / ATS 限制。
- **结论：密钥类配置永远不要进 App 包。** 如果一定要离线跑，正确做法是方案 C 的安全变体——自建一个"签发短时令牌"的网关，但那是产品化后期的事，现阶段不必。

### 选择建议

| 场景 | 方案 | 密钥放哪 |
|---|---|---|
| 自己 / 朋友试用 | B（App 内填局域网地址） | 你的电脑上 |
| 正式上架、给陌生用户用 | A（云部署） | 云服务器上 |
| 想完全离线 | 暂不支持（需要离线小模型，另行规划） | — |

---

## 四、打包 APP 时请勿忘记（Checklist）

> 这是你明确要求提醒的事项，打包前逐条打勾：

- [ ] **语音模块迁移**：Edge TTS 是微软个人级接口，**无商业授权**，上架产品必须换云 TTS（阿里百炼 / 火山豆包 / 腾讯云）。代码已按 provider 架构预留，见需求开发文档 §15.2。
- [ ] **WebView 后台播放**：加原生后台音频插件（Capacitor: `@capacitor-community/native-audio` 或 KeepAwake 方案），否则锁屏播报会停。**P0**。
- [ ] **后端地址**：方案 A 就把 https 域名写进 `web/env.js`；方案 B 则告知用户在"服务设置"里填。
- [ ] **HTTPS**：iOS ATS 强制要求（本地调试可豁免）。
- [ ] **CORS 收紧**：`ALLOW_ORIGIN` 从 `*` 改为实际来源。
- [ ] **配置接口上锁**：云端部署务必设置 `CONFIG_TOKEN`，否则任何人都能改你的模型配置。
- [ ] **识别模型含视觉能力**：换服务商后先跑"连通性自检"。

---

## 五、常见问题

**Q：换了密钥，老用户要升级 App 吗？**
A：不用。密钥在服务端，改完即时生效，App 任何版本都自动使用新密钥。

**Q：怎么确认密钥真的换了？**
A：服务设置面板「当前服务端配置」里看掩码变化；或 `GET /api/config` 看 `keyMask`。

**Q：`data/config.json` 和 `.env` 同时有配置，听谁的？**
A：`data/config.json` 优先（运行时层）。想彻底回到 `.env`，删掉 `server/data/config.json` 再重启。

**Q：端口被占用 / 想换端口？**
A：`.env` 里加 `PORT=3001`，同时 App 内"服务地址"填对应端口。

**Q：忘记改了什么，想恢复出厂？**
A：删除 `server/data/config.json` → 重启 → 回到 `.env` 的初始配置。
