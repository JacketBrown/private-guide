# 上传到 GitHub 步骤

> 项目已完成 Git 初始化和首次提交，仓库里只有源码，**密钥和构建产物都已排除**。
> 剩下的就是创建远程仓库并推送。

---

## ⚠️ 上传前必读

**本次已处理的安全项**（无需你再操作）：

| 项目 | 状态 |
|---|---|
| `server/.env`（真实密钥） | ✅ 已忽略 |
| `server/data/`（运行时配置） | ✅ 已忽略 |
| `app/www/`、`assets/public/`（构建副本） | ✅ 已忽略 |
| `dist/*.apk`、`server/build/*.cjs` | ✅ 已忽略 |
| 源码注释中泄露的密钥片段 | ✅ 已替换为占位符 |

**要记住的原则**：`.env` 永远不进仓库，改配置改 `.env.example`。

---

## 方式一：网页创建 + 命令行推送（推荐，最稳）

### 第 1 步：在 GitHub 创建空仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `private-guide-app`
3. **Description**（可选）：`私人 AI 导游 App — 拍照识别 + 可溯源的语音讲解`
4. 可见性选 **Private**（私人自用建议）或 **Public**
5. ⚠️ **不要勾选** "Add a README file"、"Add .gitignore"、"Choose a license"——本地已经有了，勾了会冲突
6. 点 **Create repository**

### 第 2 步：关联远程仓库并推送

创建完页面会显示仓库地址，在下面命令里替换 `<你的用户名>`：

```bash
cd "C:/Users/jin.wu/WorkBuddy/2026-10-09-11-39-32/private-guide-app"

# 关联远程（HTTPS 方式）
git remote add origin https://github.com/<你的用户名>/private-guide-app.git

# 设置分支名为 main
git branch -M main

# 首次推送
git push -u origin main
```

**首次推送会要求登录**。GitHub 已不支持密码，需要用 **Personal Access Token**：

1. 打开 https://github.com/settings/tokens
2. 点 **Generate new token** → **Generate new token (classic)**
3. Note 填 `local-push`，Expiration 选 `90 days`，勾选 **repo** 权限
4. 点 **Generate token**，**立即复制**（页面关闭后不再显示）
5. 回到终端：用户名填 GitHub 用户名，**密码位置粘贴这个 token**

> 建议把 token 存进 Windows 凭据管理器，输入一次后就不再问了。

---

## 方式二：GitHub CLI（如果你装了 gh）

```bash
cd "C:/Users/jin.wu/WorkBuddy/2026-10-09-11-39-32/private-guide-app"

# 登录（浏览器授权）
gh auth login

# 一条命令创建远程仓库并推送
gh repo create private-guide-app --private --source=. --push
```

> `--private` 改成 `--public` 即为公开仓库。

---

## 方式三：SSH 方式（免每次输 token）

```bash
# 1. 生成密钥（已有可跳过）
ssh-keygen -t ed25519 -C "你的邮箱"

# 2. 复制公钥
cat ~/.ssh/id_ed25519.pub

# 3. 打开 https://github.com/settings/keys → New SSH key → 粘贴 → 保存

# 4. 测试
ssh -T git@github.com

# 5. 用 SSH 地址推送
git remote set-url origin git@github.com:<你的用户名>/private-guide-app.git
git push -u origin main
```

---

## 推送后建议做的事

### 1. 完善仓库信息

在仓库页面右侧 **About** 齿轮里填：
- **Description**：`私人 AI 导游 — 拍照识别 → 可溯源讲解 → 高清语音播报`
- **Topics**：`android` `capacitor` `ai` `travel` `edge-tts` `llm` `tour-guide`

### 2. 发布 Release（方便下载 APK）

由于 APK 被 gitignore（正确的做法，仓库不该塞二进制），想给别人下载就发 Release：

1. 仓库页面右侧 → **Releases** → **Create a new release**
2. **Choose a tag**：输入 `v2.2.4` → 点 "Create new tag"
3. **Release title**：`v2.2.4`
4. **Describe**：从 `CHANGELOG.md` 复制 v2.2.4 段落
5. 拖入 `dist/私人导游-v2.2.4-直连版.apk` 到附件区
6. 点 **Publish release**

### 3. 确认密钥没漏（可选但推荐）

```bash
cd "C:/Users/jin.wu/WorkBuddy/2026-10-09-11-39-32/private-guide-app"
git log --all -p | grep -c "sk-pfju"   # 应输出 0
```

---

## 日常更新流程

以后改完代码要同步到 GitHub：

```bash
cd "C:/Users/jin.wu/WorkBuddy/2026-10-09-11-39-32/private-guide-app"

git status                     # 看改了哪些文件
git add -A                     # 暂存全部改动
git commit -m "fix: 修复 xxx"  # 提交（建议用 feat/fix/docs/chore 前缀）
git push                       # 推送
```

**如果误提交了密钥**（紧急处理）：

```bash
# 1. 立即去服务商后台吊销该密钥！ 这是最重要的一步
# 2. 从仓库历史中彻底清除
git rm --cached server/.env
echo "server/.env" >> .gitignore
git commit -m "chore: 移除误提交的密钥"
git push

# 3. 若已推送过含密钥的历史，用 git filter-repo 重写历史后强推
#    （或直接删除仓库重建，更简单）
```

> 教训：**密钥一旦推到公开仓库，就必须视为已泄露，只能吊销重发。**

---

## 常见问题

**Q：提示 `remote origin already exists`**
```bash
git remote set-url origin https://github.com/<用户名>/private-guide-app.git
```

**Q：提示 `failed to push some refs` / 远程有本地没有的提交**
```bash
git pull --rebase origin main
git push
```

**Q：网络超时 / 连接失败（国内常见）**
```bash
# 走本地代理（按你的代理端口调整）
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# 取消代理
git config --global --unset http.proxy
git config --global --unset https.proxy
```

**Q：仓库建错了想换**
```bash
git remote remove origin
git remote add origin <新地址>
git push -u origin main
```
