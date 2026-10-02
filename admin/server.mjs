import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, unlink, access, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.env.PROJECT_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const contentRoot = path.resolve(process.env.SOLITARY_CONTENT_ROOT ?? path.join(projectRoot, "src", "content"));
const siteRoot = path.resolve(process.env.SITE_ROOT ?? path.join(projectRoot, "dist"));
const host = process.env.ADMIN_HOST ?? "127.0.0.1";
const port = Number(process.env.ADMIN_PORT ?? 8888);
const username = process.env.ADMIN_USERNAME ?? "admin";
const passwordHash = process.env.ADMIN_PASSWORD_HASH ?? "";
const sessionSecret = process.env.SESSION_SECRET ?? "";
const secureCookie = process.env.ADMIN_COOKIE_SECURE === "true";
const sessionMaxAge = 60 * 60 * 24 * 7;
const maxBodySize = 1024 * 1024;

if (!passwordHash || !sessionSecret) {
  throw new Error("ADMIN_PASSWORD_HASH and SESSION_SECRET are required.");
}

const loginAttempts = new Map();
let publishQueue = Promise.resolve();

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function yamlString(value = "") {
  return JSON.stringify(String(value));
}

function isSafeSlug(value) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,120}$/u.test(value);
}

function collectionDir(kind) {
  if (kind === "note") return path.join(contentRoot, "notes");
  if (kind === "place") return path.join(contentRoot, "places");
  throw new Error("Unknown content type");
}

function normalizeKind(value) {
  return value === "place" ? "place" : "note";
}

function entryPath(kind, slug) {
  if (!isSafeSlug(slug)) throw new Error("Invalid slug");
  return path.join(collectionDir(kind), `${slug}.md`);
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue.startsWith('"')) {
      try { data[key] = JSON.parse(rawValue); continue; } catch { }
    }
    data[key] = rawValue;
  }

  return { data, body: match[2] };
}

function buildMarkdown(kind, form) {
  const type = kind === "place" ? "place" : "note";
  const common = [
    `title: ${yamlString(form.title)}`,
    `date: ${yamlString(form.date)}`,
    `description: ${yamlString(form.description)}`,
    `type: ${type}`,
  ];

  if (kind === "note") {
    if (form.place) common.push(`place: ${yamlString(form.place)}`);
  } else if (form.season) {
    common.push(`season: ${yamlString(form.season)}`);
  }

  if (form.cover) common.push(`cover: ${yamlString(form.cover)}`);

  return `---\n${common.join("\n")}\n---\n\n${form.body.trim()}\n`;
}

async function ensureDirs() {
  await mkdir(path.join(contentRoot, "notes"), { recursive: true });
  await mkdir(path.join(contentRoot, "places"), { recursive: true });
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function parseCookieHeader(value = "") {
  const cookies = {};
  for (const item of value.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return cookies;
}

function makeSession() {
  const exp = Math.floor(Date.now() / 1000) + sessionMaxAge;
  const payload = `${username}.${exp}`;
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

function validSession(token) {
  if (!token) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;

  let payload;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return false;
  }

  const [sessionUser, expText] = payload.split(".");
  if (sessionUser !== username) return false;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function isAuthenticated(req) {
  const cookies = await parseCookieHeader(req.headers.cookie ?? "");
  return validSession(cookies.st_admin);
}

function setSessionCookie(res) {
  const secure = secureCookie ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `st_admin=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAge}${secure}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "st_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>行旅手记 | ${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f3f0e9;
        --paper: #faf8f3;
        --ink: #252522;
        --muted: #77736b;
        --line: #d8d3c9;
        --accent: #53675d;
        --danger: #9f4941;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
        background: var(--bg);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        line-height: 1.6;
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      .wrap {
        width: min(calc(100% - 36px), 980px);
        margin: 0 auto;
      }

      header {
        border-bottom: 1px solid var(--line);
        background: rgba(243, 240, 233, 0.92);
        backdrop-filter: blur(12px);
      }

      .bar {
        height: 68px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
      }

      .page-heading {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 40px;
        margin-bottom: 30px;
      }

      .page-heading h1 {
        margin: 0;
      }

      .admin-nav {
        display: flex;
        align-items: center;
        gap: 22px;
        padding-bottom: 6px;
        color: var(--muted);
        font-size: 13px;
      }

      .admin-nav a:hover {
        color: var(--ink);
      }

      .brand {
        font-family: Georgia, "Times New Roman", serif;
        font-size: 20px;
      }

      nav {
        display: flex;
        gap: 16px;
        font-size: 13px;
        color: var(--muted);
      }

      main {
        flex: 1;
        padding: 48px 0 80px;
      }

      h1 {
        margin: 0;
        font: 600 clamp(32px, 5vw, 54px) / 1.15 Georgia, "Times New Roman", serif;
        letter-spacing: -0.04em;
      }

      h2 {
        margin: 0;
        font: 600 24px / 1.2 Georgia, "Times New Roman", serif;
      }

      .eyebrow {
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.2em;
      }

      .panel {
        margin-top: 30px;
        padding: 26px;
        background: var(--paper);
        border: 1px solid var(--line);
      }

      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      label {
        display: grid;
        gap: 7px;
        font-size: 12px;
        color: var(--muted);
      }

      input,
      textarea,
      select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 3px;
        background: #fffdf9;
        color: var(--ink);
        font: inherit;
        padding: 10px 12px;
        outline: none;
      }

      textarea {
        min-height: 360px;
        resize: vertical;
        line-height: 1.7;
      }

      input:focus,
      textarea:focus,
      select:focus {
        border-color: var(--accent);
      }

      .actions {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-top: 20px;
      }

      .buttons {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      button,
      .button {
        border: 0;
        border-radius: 999px;
        min-height: 40px;
        padding: 0 16px;
        font: 600 13px inherit;
        cursor: pointer;
      }

      .primary {
        background: var(--accent);
        color: #fff;
      }

      .secondary {
        background: transparent;
        border: 1px solid var(--line);
      }

      .danger {
        background: transparent;
        border: 1px solid #d5aaa5;
        color: var(--danger);
      }

      .notice {
        padding: 12px 14px;
        border: 1px solid var(--line);
        background: rgba(250, 248, 243, 0.65);
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 16px;
      }

      .error {
        border-color: #ddb1ac;
        color: var(--danger);
      }

      .list {
        display: grid;
        border-top: 1px solid var(--line);
      }

      .item {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        padding: 18px 0;
        border-bottom: 1px solid var(--line);
        align-items: center;
      }

      .item-meta {
        font-size: 11px;
        color: var(--muted);
      }

      .muted {
        color: var(--muted);
        font-size: 13px;
      }

      .empty {
        padding: 55px 20px;
        text-align: center;
        color: var(--muted);
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        margin-top: 30px;
      }

      .login {
        width: min(calc(100% - 36px), 420px);
        margin: 10vh auto 0;
      }

      .login .panel {
        margin-top: 20px;
      }

      .logout-form {
        margin: 0;
      }

      .site-footer {
        border-top: 1px solid var(--line);
        padding: 28px 0;
        margin-top: 40px;
        color: var(--muted);
        font-size: 11px;
      }

      .footer-wrap {
        width: min(calc(100% - 36px), 980px);
        margin: 0 auto;
        display: flex;
        justify-content: space-between;
        gap: 20px;
      }

      @media (max-width: 700px) {
        .page-heading {
          align-items: flex-start;
          flex-direction: column;
          gap: 16px;
        }

        .admin-nav {
          padding-bottom: 0;
        }

        .grid {
          grid-template-columns: 1fr;
        }

        .bar {
          height: auto;
          padding: 16px 0;
          align-items: flex-start;
        }

        .bar nav {
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .item {
          align-items: flex-start;
          flex-direction: column;
        }

        .actions {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="wrap bar">
        <a class="brand" href="/admin">行旅手记 · 后台管理</a>
        <form class="logout-form" method="post" action="/admin/logout">
          <button class="secondary" type="submit">退出</button>
        </form>
      </div>
    </header>
    <main class="wrap">${body}</main>
    <footer class="site-footer">
      <div class="footer-wrap">
        <span
          >© ${new Date().getFullYear() === 2026
      ? "2026"
      : `2026–${new Date().getFullYear()}`
    } · 行旅手记 · Solitary Traveler</span
        >
        <span>走过的路、遇见的人、眼中的世界</span>
      </div>
    </footer>
  </body>
</html>`;
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>行旅手记 | 登录</title>
    <style>
      :root {
        --bg: #f3f0e9;
        --paper: #faf8f3;
        --ink: #252522;
        --muted: #77736b;
        --line: #d8d3c9;
        --accent: #53675d;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      .box {
        width: min(calc(100% - 36px), 420px);
        margin: 14vh auto;
      }

      .brand {
        text-align: center;
        font: 600 34px Georgia, "Times New Roman", serif;
      }

      .sub {
        text-align: center;
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.18em;
        margin-top: 6px;
      }

      .panel {
        margin-top: 28px;
        padding: 26px;
        background: var(--paper);
        border: 1px solid var(--line);
      }

      label {
        display: grid;
        gap: 7px;
        margin-bottom: 16px;
        font-size: 12px;
        color: var(--muted);
      }

      input {
        width: 100%;
        padding: 11px;
        border: 1px solid var(--line);
        background: #fffdf9;
        font: inherit;
      }

      button {
        width: 100%;
        height: 44px;
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }

      .error {
        margin-bottom: 16px;
        color: #9f4941;
        font-size: 13px;
      }

      .site-footer {
        border-top: 1px solid var(--line);
        padding: 28px 0;
        margin-top: 40px;
        color: var(--muted);
        font-size: 11px;
      }

      .footer-wrap {
        width: min(calc(100% - 36px), 980px);
        margin: 0 auto;
        display: flex;
        justify-content: space-between;
        gap: 20px;
      }

      @media (max-width: 700px) {
        .footer-wrap {
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 6px;
        }
      }
    </style>
  </head>
  <body>
    <div class="box">
      <div class="brand">行旅手记</div>
      <div class="sub">SOLITARY TRAVELER · ADMIN</div>
      <div class="panel">
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
        <form method="post" action="/admin/login">
          <label>
            用户名
            <input name="username" autocomplete="username" required>
          </label>
          <label>
            密码
            <input type="password" name="password" autocomplete="current-password" required>
          </label>
          <button type="submit">登录</button>
        </form>
      </div>

      <footer class="site-footer">
        <div class="footer-wrap">
          <span
            >© ${new Date().getFullYear() === 2026
      ? "2026"
      : `2026–${new Date().getFullYear()}`
    } · 行旅手记 · Solitary Traveler</span
          >
          <span>走过的路、遇见的人、眼中的世界</span>
        </div>
      </footer>
    </div>
  </body>
</html>`;
}

function dashboard() {
  return layout("后台管理", `
    <div class="page-heading">
      <div>
        <p class="eyebrow">ADMINISTRATION</p>
        <h1>管理你的行旅记录。</h1>
      </div>
    </div>

    <div class="grid">
      <a class="panel" href="/admin/notes">
        <h2>随笔</h2>
        <p class="muted">新建、编辑和删除旅途随笔。</p>
      </a>

      <a class="panel" href="/admin/places">
        <h2>地方</h2>
        <p class="muted">记录去过的地方和旅行片段。</p>
      </a>
    </div>
  `);
}

async function listEntries(kind) {
  const dir = collectionDir(kind);
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  const result = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    const raw = await readFile(path.join(dir, file), "utf8");
    const parsed = parseFrontmatter(raw);
    result.push({ slug, ...parsed.data });
  }
  result.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return result;
}

async function listPage(kind) {
  const isNote = kind === "note";
  const items = await listEntries(kind);
  const title = isNote ? "随笔" : "地方";
  const newPath = isNote ? "/admin/notes/new" : "/admin/places/new";
  const base = isNote ? "/admin/notes" : "/admin/places";

  const listHtml = items.length
    ? `<div class="list">
        ${items.map((item) => `
          <article class="item">
            <div>
              <h2>
                <a href="${base}/edit/${encodeURIComponent(item.slug)}">${escapeHtml(item.title ?? item.slug)}</a>
              </h2>
              <div class="item-meta">
                ${escapeHtml(item.date ?? "")} · ${escapeHtml(item.description ?? "")}
              </div>
            </div>
            <a class="button secondary" href="${base}/edit/${encodeURIComponent(item.slug)}">编辑</a>
          </article>
        `).join("")}
      </div>`
    : `<div class="empty">还没有${title}。<br>下一段记录，就从这里开始。</div>`;

  return layout(title, `
    <p class="eyebrow">${isNote ? "TRAVEL NOTES" : "PLACES"}</p>

    <div class="actions">
      <h1>${title}</h1>
      <a class="button primary" href="${newPath}">+ 新建${title}</a>
    </div>

    ${listHtml}
  `);
}

async function editorPage(kind, slug = "", error = "") {
  const isNote = kind === "note";
  let entry = {
    slug,
    title: "",
    date: new Date().toISOString().slice(0, 10),
    description: "",
    place: "",
    season: "",
    cover: "",
    body: "",
  };

  if (slug) {
    const raw = await readFile(entryPath(kind, slug), "utf8");
    const parsed = parseFrontmatter(raw);
    entry = { ...entry, ...parsed.data, body: parsed.body };
  }

  const base = isNote ? "/admin/notes" : "/admin/places";
  const action = slug ? `${base}/save/${encodeURIComponent(slug)}` : `${base}/save`;

  const extra = isNote
    ? `<label>地点<input name="place" value="${escapeAttr(entry.place ?? "")}" maxlength="100"></label>`
    : `<label>季节 / 标记<input name="season" value="${escapeAttr(entry.season ?? "")}" maxlength="100" placeholder="例如 海滨 · 秋"></label>`;

  return layout(slug ? `编辑 · ${entry.title}` : `新建 · ${isNote ? "随笔" : "地方"}`, `
    <p class="eyebrow">${isNote ? "TRAVEL NOTE" : "PLACE"}</p>
    <h1>${slug ? "编辑" : "新建"}${isNote ? "随笔" : "地方"}</h1>

    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}

    <form class="panel" method="post" action="${action}">
      <div class="grid">
        <label>
          标题
          <input name="title" value="${escapeAttr(entry.title)}" required maxlength="160">
        </label>
        <label>
          日期
          <input type="date" name="date" value="${escapeAttr(String(entry.date).slice(0, 10))}" required>
        </label>
      </div>

      <div class="stack" style="margin-top: 16px">
        <label>
          URL Slug${slug ? "（不可修改）" : ""}
          <input name="slug" value="${escapeAttr(entry.slug)}" ${slug ? "readonly" : "required"} maxlength="121" placeholder="例如 2026-10-01-海边">
        </label>

        <label>
          简介
          <input name="description" value="${escapeAttr(entry.description)}" required maxlength="240">
        </label>

        ${extra}

        <label>
          封面图片路径（可选）
          <input name="cover" value="${escapeAttr(entry.cover ?? "")}" placeholder="例如 /images/notes/sea.jpg">
        </label>

        <label>
          正文（Markdown）
          <textarea name="body" required>${escapeHtml(entry.body)}</textarea>
        </label>
      </div>

      <div class="actions">
        <div class="buttons">
          <a class="button secondary" href="${base}">取消</a>
          ${slug
      ? `<button class="danger" type="submit" formaction="${base}/delete/${encodeURIComponent(slug)}" formmethod="post" onclick="return confirm('确定删除这篇内容吗？')">删除</button>`
      : ""}
        </div>
        <button class="primary" type="submit">保存并发布</button>
      </div>
    </form>
  `);
}

async function readRequestBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodySize) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formData(raw) {
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function rateLimited(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip);
  if (!item || item.resetAt < now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  return item.count >= 5;
}

function recordLoginFailure(ip) {
  const item = loginAttempts.get(ip) ?? { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  item.count += 1;
  loginAttempts.set(ip, item);
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function verifyPassword(password) {
  const parts = passwordHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function runBuild() {
  const job = publishQueue.catch(() => { }).then(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: projectRoot,
      env: { ...process.env, SOLITARY_CONTENT_ROOT: contentRoot },
      maxBuffer: 10 * 1024 * 1024,
    });

    await execFileAsync("rsync", ["-az", "--delete", "dist/", `${siteRoot}/`], {
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
  });
  publishQueue = job.catch(() => { });
  return job;
}

async function saveEntry(kind, slug, form) {
  await ensureDirs();
  const targetSlug = slug || String(form.slug ?? "").trim();
  if (!isSafeSlug(targetSlug)) throw new Error("Slug 只能包含中文、英文、数字、点、短横线和下划线，且不能以符号开头。");

  const target = entryPath(kind, targetSlug);
  const existed = await exists(target);
  const old = existed ? await readFile(target) : null;
  const data = {
    title: String(form.title ?? "").trim(),
    date: String(form.date ?? "").trim(),
    description: String(form.description ?? "").trim(),
    place: String(form.place ?? "").trim(),
    season: String(form.season ?? "").trim(),
    cover: String(form.cover ?? "").trim(),
    body: String(form.body ?? "").trim(),
  };

  if (!data.title || !data.date || !data.description || !data.body) {
    throw new Error("标题、日期、简介和正文不能为空。");
  }

  await writeFile(target, buildMarkdown(kind, data), "utf8");
  try {
    await runBuild();
  } catch (error) {
    if (old) await writeFile(target, old);
    else if (await exists(target)) await unlink(target);
    throw error;
  }
}

async function deleteEntry(kind, slug) {
  const target = entryPath(kind, slug);
  const old = await readFile(target);
  await unlink(target);
  try {
    await runBuild();
  } catch (error) {
    await writeFile(target, old);
    throw error;
  }
}

async function handle(req, res) {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = requestUrl.pathname;
  const ip = req.socket.remoteAddress ?? "unknown";

  if (req.method === "GET" && (pathname === "/admin/login" || pathname === "/admin/login/")) {
    return sendHtml(res, loginPage(requestUrl.searchParams.get("error") ?? ""));
  }

  if (req.method === "POST" && pathname === "/admin/login") {
    if (rateLimited(ip)) return sendHtml(res, loginPage("登录尝试过于频繁，请稍后再试。"), 429);
    const raw = await readRequestBody(req);
    const form = formData(raw);
    if (String(form.username) === username && verifyPassword(String(form.password ?? ""))) {
      clearLoginFailures(ip);
      setSessionCookie(res);
      return redirect(res, "/admin");
    }
    recordLoginFailure(ip);
    return sendHtml(res, loginPage("用户名或密码不正确。"), 401);
  }

  if (!(await isAuthenticated(req))) {
    return redirect(res, "/admin/login");
  }

  if (req.method === "POST" && pathname === "/admin/logout") {
    clearSessionCookie(res);
    return redirect(res, "/admin/login");
  }

  if (req.method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
    return sendHtml(res, dashboard());
  }

  if (req.method === "GET" && pathname === "/admin/notes") return sendHtml(res, await listPage("note"));
  if (req.method === "GET" && pathname === "/admin/places") return sendHtml(res, await listPage("place"));

  if (req.method === "GET" && pathname === "/admin/notes/new") return sendHtml(res, await editorPage("note"));
  if (req.method === "GET" && pathname === "/admin/places/new") return sendHtml(res, await editorPage("place"));

  const noteEdit = pathname.match(/^\/admin\/notes\/edit\/([^/]+)$/);
  if (req.method === "GET" && noteEdit) return sendHtml(res, await editorPage("note", decodeURIComponent(noteEdit[1])));

  const placeEdit = pathname.match(/^\/admin\/places\/edit\/([^/]+)$/);
  if (req.method === "GET" && placeEdit) return sendHtml(res, await editorPage("place", decodeURIComponent(placeEdit[1])));

  const noteSave = pathname.match(/^\/admin\/notes\/save(?:\/([^/]+))?$/);
  if (req.method === "POST" && noteSave) {
    const raw = await readRequestBody(req);
    const form = formData(raw);
    try {
      await saveEntry("note", noteSave[1] ? decodeURIComponent(noteSave[1]) : "", form);
      return redirect(res, "/admin/notes");
    } catch (error) {
      return sendHtml(res, await editorPage("note", noteSave[1] ? decodeURIComponent(noteSave[1]) : "", error.message));
    }
  }

  const placeSave = pathname.match(/^\/admin\/places\/save(?:\/([^/]+))?$/);
  if (req.method === "POST" && placeSave) {
    const raw = await readRequestBody(req);
    const form = formData(raw);
    try {
      await saveEntry("place", placeSave[1] ? decodeURIComponent(placeSave[1]) : "", form);
      return redirect(res, "/admin/places");
    } catch (error) {
      return sendHtml(res, await editorPage("place", placeSave[1] ? decodeURIComponent(placeSave[1]) : "", error.message));
    }
  }

  const noteDelete = pathname.match(/^\/admin\/notes\/delete\/([^/]+)$/);
  if (req.method === "POST" && noteDelete) {
    try { await deleteEntry("note", decodeURIComponent(noteDelete[1])); return redirect(res, "/admin/notes"); }
    catch (error) { return sendHtml(res, layout("删除失败", `<div class="notice error">${escapeHtml(error.message)}</div><a class="button secondary" href="/admin/notes">返回</a>`), 500); }
  }

  const placeDelete = pathname.match(/^\/admin\/places\/delete\/([^/]+)$/);
  if (req.method === "POST" && placeDelete) {
    try { await deleteEntry("place", decodeURIComponent(placeDelete[1])); return redirect(res, "/admin/places"); }
    catch (error) { return sendHtml(res, layout("删除失败", `<div class="notice error">${escapeHtml(error.message)}</div><a class="button secondary" href="/admin/places">返回</a>`), 500); }
  }

  return sendHtml(res, layout("404", `<h1>找不到这个后台页面。</h1>`), 404);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    sendHtml(res, layout("500", `<div class="notice error">${escapeHtml(error.message)}</div>`), 500);
  });
});

server.listen(port, host, () => {
  console.log(`Admin server listening on http://${host}:${port}`);
  console.log(`Content root: ${contentRoot}`);
});
