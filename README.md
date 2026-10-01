# 行旅手记 · Solitary Traveler

一个用于记录旅途、风景与生活片段的个人静态网站。

访问 https://4131029.xyz 预览。

---

## 特性

- 基于 Astro 的静态网站；

- 响应式布局，适配桌面与移动设备；

- 随笔与地方使用 Markdown 管理；

- 首页自动展示最新内容；

- 独立的 404 页面；

- 可选的登录管理后台。

## 项目结构

```text
├── admin/                           # 管理后台
│   ├── server.mjs
│   └── generate-password.mjs
│
├── deploy/                          # 部署示例
│   ├── Caddyfile.admin.example
│   └── solitary-traveler-admin.service
│
├── docs/                            # 项目预览图片
│
├── public/
│   └── images/                      # 网站公共图片
│
├── src/
│   ├── components/                  # 公共组件
│   ├── content/                     # 本地开发用内容目录
│   │   ├── notes/
│   │   └── places/
│   ├── layouts/                     # 页面布局
│   ├── pages/                       # 页面与动态路由
│   └── styles/                      # 全局样式
│
├── .env.example                     # 环境变量示例
├── astro.config.mjs
├── package.json
├── package-lock.json
└── README.md
```
---

## 本地开发

安装依赖：

```bash
npm install
```

启动服务：

```bash
npm run dev
```

构建静态网站：

```bash
npm run build
```

预览构建结果：

```bash
npm run preview
```

### 本地运行管理后台

运行以下命令行，根据提示输入密码，生成密码哈希：

```bash
npm run admin:password
```

再设置后台环境变量，PowerShell 示例：

```powershell
$env:ADMIN_HOST='127.0.0.1'
$env:ADMIN_PORT='8888'
$env:ADMIN_USERNAME='admin'
$env:ADMIN_PASSWORD_HASH='这里填写生成的完整 scrypt 哈希'
$env:SESSION_SECRET='这里填写随机字符串'
$env:ADMIN_COOKIE_SECURE='false'

npm run admin
```

然后访问 `http://localhost:8888/admin` 即可进入管理后台。

---

## 内容管理

### 随笔

本地开发时，内容放在 `src/content/notes/`，例如 `随笔示例.md`：

```md
---
title: 这是标题
date: 2026-10-01
description: 这是简短的描述。
type: note
place: 这是地点
---

这里写随笔具体内容。
```

### 地方

地方记录放在 `src/content/places/`，例如 `地方示例.md`：

```md
---
title: 这是标题
date: 2026-10-15
description: 这是简短的描述。
type: place
season: 这是季节
---

这里写关于这个地方的记录。
```

### 生产环境的私人内容

公开仓库不保存个人真实记录，生产环境把内容放到仓库之外：

```text
/var/lib/solitary-traveler/content/
                          ├── notes/
                          └── places/
```

通过 `SOLITARY_CONTENT_ROOT` 指向该目录，个人随笔和地方记录不会进入公开仓库。

---

## 服务器部署

下面以 Debian + Caddy + systemd 为例，介绍生产环境的核心部署方式。

项目推荐使用独立系统用户 `solitary-traveler`。

生产环境目录：

- `/opt/solitary-traveler` GitHub 项目源码。
- `/var/lib/solitary-traveler/content` 私人随笔、地方记录和私人图片。
- `/var/www/solitary-traveler` Astro 构建后的静态网站。
- `/etc/solitary-traveler/admin.env` 管理后台生产环境变量。


整体结构：

```text
GitHub
  ↓
/opt/solitary-traveler
            ↓ npm run build
          dist/
            ↓ rsync
/var/www/solitary-traveler
  ↓
Caddy
  ├── https://4131029.xyz/
  └── https://4131029.xyz/admin
                            ↓
                      127.0.0.1:8888
                            ↓
                       Node.js 后台
```

### 部署前提

服务器需要准备以下依赖：

```text
Git
Node.js 22.12+
npm
rsync
Caddy
```

域名需要解析到服务器 IP，添加 A/AAAA 记录：

```text
4131029.xyz      A/AAAA      <IPv4/IPv6 地址>
www.4131029.xyz  A/AAAA      <IPv4/IPv6 地址>
```

公网至少开放：

```text
TCP 22     SSH
TCP 80     HTTP
TCP 443    HTTPS
```

管理后台使用 `127.0.0.1:8888`，不应直接暴露到公网。

### 1. 创建项目用户和目录

使用独立用户运行项目，不建议使用 `root` 运行管理后台：

```bash
sudo adduser --system --group --home /opt/solitary-traveler solitary-traveler

sudo mkdir -p /opt/solitary-traveler

sudo mkdir -p /var/lib/solitary-traveler/content/notes

sudo mkdir -p /var/lib/solitary-traveler/content/places

sudo mkdir -p /var/www/solitary-traveler

sudo mkdir -p /etc/solitary-traveler

sudo chown -R solitary-traveler:solitary-traveler \
  /opt/solitary-traveler \
  /var/lib/solitary-traveler \
  /var/www/solitary-traveler
```

### 2. 获取源码并安装依赖

```bash
sudo -u solitary-traveler git clone \
  https://github.com/Hxina/solitary-traveler.git \
  /opt/solitary-traveler

cd /opt/solitary-traveler

sudo -u solitary-traveler npm ci
```

后续更新源码：

```bash
cd /opt/solitary-traveler

sudo -u solitary-traveler git pull --ff-only

sudo -u solitary-traveler npm ci
```

### 3. 配置生产环境变量

创建环境变量：

```bash
sudo nano /etc/solitary-traveler/admin.env
```

添加以下内容：

```env
SOLITARY_CONTENT_ROOT=/var/lib/solitary-traveler/content
PROJECT_ROOT=/opt/solitary-traveler
SITE_ROOT=/var/www/solitary-traveler

ADMIN_HOST=127.0.0.1
ADMIN_PORT=8888
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt$...
SESSION_SECRET=...
ADMIN_COOKIE_SECURE=true
```

生成 `ADMIN_PASSWORD_HASH`：

```bash
cd /opt/solitary-traveler

sudo -u solitary-traveler npm run admin:password
```

生成 `SESSION_SECRET`：

```bash
openssl rand -hex 32
```

修改环境变量文件权限：

```bash
sudo chown root:root /etc/solitary-traveler/admin.env

sudo chmod 600 /etc/solitary-traveler/admin.env
```

### 4. 构建并发布静态网站

生产环境的私人内容放在仓库之外：

```text
/var/lib/solitary-traveler/content/
                          ├── notes/
                          └── places/
```

使用该目录构建：

```bash
cd /opt/solitary-traveler

sudo -u solitary-traveler env \
  SOLITARY_CONTENT_ROOT=/var/lib/solitary-traveler/content \
  PROJECT_ROOT=/opt/solitary-traveler \
  SITE_ROOT=/var/www/solitary-traveler \
  npm run build
```

同步构建结果：

```bash
sudo -u solitary-traveler rsync -az --delete \
  /opt/solitary-traveler/dist/ \
  /var/www/solitary-traveler/
```

### 5. 部署管理后台

将项目提供的 `deploy/solitary-traveler-admin.service` 复制到 systemd：

```bash
sudo cp /opt/solitary-traveler/deploy/solitary-traveler-admin.service \
  /etc/systemd/system/solitary-traveler-admin.service

sudo systemctl daemon-reload

sudo systemctl enable --now solitary-traveler-admin
```

确认 `deploy/solitary-traveler-admin.service` 使用生产环境变量文件，并以专用用户运行：

```ini
EnvironmentFile=/etc/solitary-traveler/admin.env
User=solitary-traveler
Group=solitary-traveler
```

执行以下命令检查：

```bash
sudo systemctl status solitary-traveler-admin

sudo ss -lntp | grep 8888
```

正常情况下后台只监听 `127.0.0.1:8888`。

### 6. 配置 Caddy

编辑 Caddyfile：

```text
sudo nano /etc/caddy/Caddyfile
```

配置示例：

```caddyfile
4131029.xyz, www.4131029.xyz {
    handle /admin* {
        reverse_proxy 127.0.0.1:8888
    }

    handle {
        root * /var/www/solitary-traveler
        file_server
    }

    handle_errors 404 {
        rewrite /404.html
        file_server
    }
}
```

检查并重新加载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

部署完成后，以下两个网址即可正常访问：

```text
https://4131029.xyz/
https://4131029.xyz/admin
```

### 7. 更新网站

修改代码并推送 GitHub 后：

```bash
cd /opt/solitary-traveler

sudo -u solitary-traveler git pull --ff-only

sudo -u solitary-traveler npm ci
```

后台代码有变化时：

```bash
sudo systemctl restart solitary-traveler-admin
```

前台代码有变化时重新构建并同步：

```bash
sudo -u solitary-traveler env \
  SOLITARY_CONTENT_ROOT=/var/lib/solitary-traveler/content \
  PROJECT_ROOT=/opt/solitary-traveler \
  SITE_ROOT=/var/www/solitary-traveler \
  npm run build

sudo -u solitary-traveler rsync -az --delete \
  /opt/solitary-traveler/dist/ \
  /var/www/solitary-traveler/
```

### 8. 常用排错命令

后台管理：

```bash
sudo systemctl status solitary-traveler-admin

sudo journalctl -u solitary-traveler-admin -n 100 --no-pager
```

Caddy：

```bash
sudo systemctl status caddy

sudo journalctl -u caddy -n 100 --no-pager
```

本机测试后台：

```bash
curl -I http://127.0.0.1:8888/admin
```

---

## 截图预览

![首页](docs/images/行旅手记-首页.png)
![随笔](docs/images/行旅手记-随笔.png)
![地方](docs/images/行旅手记-地方.png)
![404](docs/images/行旅手记-404.png)
