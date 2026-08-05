#!/usr/bin/env node
/**
 * 115 网页版"最近记录"接口抓包脚本
 *
 * 用法：
 *   pnpm dlx playwright install chromium     # 首次运行前安装浏览器
 *   node scripts/sniff-115-recent.mjs        # 启动抓包
 *
 * 行为：
 *   1. 启动一个有界面的 Chromium，使用持久化用户目录（首次需扫码登录）
 *   2. 监听所有发往 115 域名的 XHR/fetch 请求
 *   3. 自动跳转到"最近记录"页面，并尝试翻页触发更多请求
 *   4. 把命中的接口（请求 + 响应）打印到控制台，并写入 scripts/115-recent-capture.json
 *   5. 命中关键词（recent / history / log / event / opt / record）的接口会用 ★ 高亮
 *
 * 退出：在终端按 Ctrl+C，或直接关闭浏览器窗口
 */

import { chromium } from "playwright";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(__dirname, "115-recent-capture.json");
const USER_DATA_DIR = join(__dirname, ".115-profile");

// 只关心这些域名
const HOST_KEYWORDS = ["115.com", "115cdn.com", "anxia.com", "proapi.115", "webapi.115", "pro.api.115", "web.api.115"];
// 接口路径命中这些关键词时高亮
const PATH_KEYWORDS = ["recent", "history", "log", "event", "opt", "record", "operate", "action", "list_log"];

const captured = [];
const seen = new Set(); // 去重 key: method+url+body

function shouldCapture(url) {
  try {
    const u = new URL(url);
    return HOST_KEYWORDS.some((h) => u.hostname.includes(h));
  } catch {
    return false;
  }
}

function isHighlight(url) {
  const lower = url.toLowerCase();
  return PATH_KEYWORDS.some((k) => lower.includes(k));
}

function headersToObj(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    // 脱敏 cookie，只保留前 40 字符
    if (k.toLowerCase() === "cookie") {
      out[k] = String(v).slice(0, 40) + "...(truncated)";
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function main() {
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log("————————————————————————————————————————————");
  console.log(" 115 最近记录 抓包脚本");
  console.log("————————————————————————————————————————————");
  console.log(`用户数据目录: ${USER_DATA_DIR}`);
  console.log(`输出文件:     ${OUTPUT_FILE}`);
  console.log("首次运行需在浏览器内扫码登录 115，之后会复用登录态\n");

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();

  // 监听所有请求
  page.on("request", (req) => {
    const url = req.url();
    if (!shouldCapture(url)) return;
    if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch") return;

    const method = req.method();
    const postData = req.postData() || "";

    // 响应到达时再记录，这样能拿到 status 和 body
    req.response()
      .then(async (res) => {
        const key = `${method} ${url} ${postData}`;
        if (seen.has(key)) return;
        seen.add(key);

        const highlight = isHighlight(url);
        let bodyText = "";
        try {
          const buf = await res.body();
          bodyText = buf.toString("utf8");
          // 截断超长响应
          if (bodyText.length > 8000) bodyText = bodyText.slice(0, 8000) + "\n...(truncated)";
        } catch (e) {
          bodyText = `(无法读取 body: ${e.message})`;
        }

        const entry = {
          ts: new Date().toISOString(),
          highlight,
          method,
          url,
          status: res.status(),
          requestHeaders: headersToObj(req.headers()),
          postData: postData || undefined,
          responseHeaders: headersToObj(res.headers()),
          responseBody: bodyText,
        };
        captured.push(entry);

        const tag = highlight ? "★ HIT" : "     ";
        console.log(`\n[${tag}] ${method} ${res.status()} ${url}`);
        if (postData) console.log(`  body: ${postData.slice(0, 200)}`);
        if (highlight) {
          // 命中关键词的接口，打印响应字段提示
          try {
            const j = JSON.parse(bodyText);
            const keys = j && typeof j === "object" ? Object.keys(j) : [];
            console.log(`  resp keys: ${keys.join(", ")}`);
            if (j?.data && typeof j.data === "object") {
              console.log(`  data keys: ${Object.keys(j.data).join(", ")}`);
            }
          } catch {}
        }

        // 实时落盘，防止中断丢失
        writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2));
      })
      .catch(() => {});
  });

  // 自动导航到 115 首页 → 让用户登录或自动跳转到最近记录
  console.log("\n→ 打开 115 首页，请在浏览器内完成登录（如未登录）");
  await page.goto("https://115.com/?cid=0&offset=0&tab=&mode=wake", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("→ 5 秒后尝试打开「最近记录」页面...");
  await page.waitForTimeout(5000);

  // 115 网页版"最近"入口的几种可能 URL，依次尝试
  const recentUrls = [
    "https://115.com/?tab=recent",
    "https://115.com/?cid=0&offset=0&tab=recent&mode=wake",
    "https://115.com/?cid=0&offset=0&tab=operate",
    "https://115.com/operate",
  ];
  for (const u of recentUrls) {
    try {
      console.log(`  → 尝试 ${u}`);
      await page.goto(u, { waitUntil: "networkidle", timeout: 20000 });
    } catch (e) {
      console.log(`  × 失败: ${e.message}`);
    }
  }

  console.log("\n→ 已停在 115 页面。请在浏览器内手动点击「最近」/「最近记录」/「最近操作」");
  console.log("  尝试触发：上传、转存、删除等操作，让接口请求出现");
  console.log("  抓到的接口会实时写入：", OUTPUT_FILE);
  console.log('  完成后按 Ctrl+C 退出，或关闭浏览器窗口\n');

  // 关闭浏览器时退出
  browser.on("close", () => {
    writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2));
    console.log(`\n✓ 已保存 ${captured.length} 条记录到 ${OUTPUT_FILE}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
