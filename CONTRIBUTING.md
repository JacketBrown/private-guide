# 贡献指南

## 提交前检查

1. **不要提交密钥** —— `.env`、`server/data/` 已在 `.gitignore` 中，改配置请改 `.env.example`
2. **不要提交构建产物** —— `web/` 是唯一前端源码，`www/` 和 `assets/public/` 都是它的副本
3. 改完 `web/` 后需要 `cd app && node sync-www.js` 再编译

## 开发流程

```bash
# 前端源码在 web/，改完同步到安卓工程
cd app
node sync-www.js
cd android && ./gradlew.bat assembleDebug
```

## 版本号规则

`X.Y.Z`，对应 `versionCode = X*10 + Y`（如 2.2.4 → 11）：

```bash
cd app
node update-version.js 2.2.4 11
```

## 代码风格

- 前端：无框架原生 JS，IIFE 模块模式，避免引入构建工具
- CSS：设计变量集中在 `theme.css`，页面样式在 `main.css`
- 所有可编辑输入元素字号 **必须 ≥ 16px**（低于 16px 会触发 Android WebView 聚焦缩放，导致光标定位错位）
- Java：注释用中文，注意 lambda 内引用自身初始化中的局部变量需用数组容器中转

## 真机验证清单

改动语音或输入相关逻辑后，务必真机验证：

- [ ] 拍照 → 识别 → 讲解全链路
- [ ] 手动输入框：点中间位置，字确实插在光标处
- [ ] 音色试听：切换音色是否秒出声
- [ ] 无照片路径：讲解页是否显示占位图而非破图
- [ ] 切后台 / 息屏后返回，语音状态是否正常
