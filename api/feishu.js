/**
 * 飞书消息机器人 Webhook 处理逻辑
 * 由 server.js 挂载到 POST /api/feishu（PM2 运行）
 *
 * 飞书文档：请求地址校验需在 1 秒内返回 HTTP 200，响应体为 JSON 且包含 challenge 字段。
 * 未配置 Encrypt Key 时请求体为 {"type":"url_verification","challenge":"xxx"} 或 {"challenge":"xxx"}。
 * 配置了 Encrypt Key 时请求体为 {"encrypt":"..."}，需先解密再取 challenge（当前未实现解密）。
 */

const fs = require("fs").promises;
const path = require("path");
const https = require("https");
const { Client, withTenantKey } = require("@larksuiteoapi/node-sdk");

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// 不自建应用发消息需 token；disableTokenCache: true 时 SDK 不会附加 token，导致 99991661
const larkClient =
  APP_ID && APP_SECRET
    ? new Client({
        appId: APP_ID,
        appSecret: APP_SECRET,
      })
    : null;

/** OA 登录校验：cookie 文件路径，可用环境变量 OA_COOKIE_FILE 覆盖 */
const OA_COOKIE_FILE = path.join(process.cwd(), "/data/.oa-cookie");
const OA_LOGIN_CHECK_URL =
  "https://oa.teligen-cloud.com:8280/meip/loginController/getLoginInfo";
const OA_VERIFY_CODE_URL =
  "https://oa.teligen-cloud.com:8280/meip/loginController/verifyCode/ImageCode";
const OA_VALID_LOGIN_URL =
  "https://oa.teligen-cloud.com:8280/meip/loginController/validLogin";
const OA_BMTOPIC_GET_URL =
  "https://oa.teligen-cloud.com:8280/meip/bmtopic/get";
const OA_BMTOPIC_SAVE_ANSWER_URL =
  "https://oa.teligen-cloud.com:8280/meip/bmtopic/saveAnswer";
const OA_VERIFY_CODE_IMAGE_PATH = path.join(
  process.cwd(),
  "/data/.oa-verify-code.png",
);

/** 飞书上传图片并获取 image_key（用于发送图片消息） */
const FEISHU_IMAGES_URL = "https://open.feishu.cn/open-apis/im/v1/images";
const FEISHU_IMAGE_TYPE = "message";

/**
 * 获取飞书 tenant_access_token（用于上传图片等 Open API）
 * @returns {Promise<string|null>}
 */
async function getTenantAccessToken() {
  if (!APP_ID || !APP_SECRET) return null;
  const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf8"),
      },
      body,
    },
  );
  const json = await res.json();
  return json.tenant_access_token || null;
}

/**
 * 将图片 Buffer 上传到飞书，返回 image_key。
 * @param {string} token - tenant_access_token
 * @param {Buffer} imageBuffer - 图片二进制
 * @returns {Promise<string|null>} image_key 或 null
 */
async function uploadImageToFeishu(token, imageBuffer) {
  const form = new FormData();
  form.append(
    "image",
    new Blob([imageBuffer], { type: "image/png" }),
    "verify.png",
  );
  form.append("image_type", FEISHU_IMAGE_TYPE);
  const res = await fetch(FEISHU_IMAGES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json();
  console.log("上传验证码图片到飞书成功，返回数据：", json);
  const key = json.data?.image_key ?? json.image_key;
  return key || null;
}

/**
 * 读取本地 cookie 文件，用 cookie 请求 OA 接口校验是否登录有效。
 * @returns {Promise<string>} 有效返回「登录有效」，否则返回原因说明
 */
async function loginHandler() {
  let cookieStr;
  try {
    try {
      await fs.access(OA_COOKIE_FILE);
    } catch (e) {
      if (e.code === "ENOENT") await fs.writeFile(OA_COOKIE_FILE, "");
    }
    cookieStr = await fs.readFile(OA_COOKIE_FILE, "utf8");
  } catch (e) {
    console.error("读取 cookie 文件失败：", e);
    if (e.code === "ENOENT")
      return "未找到 cookie 文件，请先配置 .oa-cookie 或 OA_COOKIE_FILE";
    throw e;
  }
  cookieStr = (cookieStr || "").trim();
  if (!cookieStr) {
    return await reloginHandler();
  }

  return new Promise((resolve) => {
    const url = new URL(OA_LOGIN_CHECK_URL);
    console.log("loginHandler cookieStr", cookieStr);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: { Cookie: cookieStr },
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(`登录已失效（HTTP ${res.statusCode}）`);
          return;
        }
        // 登录页会包含「登 录」「温馨提示」等文案，有用户信息或非登录页则视为有效
        console.log("loginHandler body", body);
        if (body && body.startsWith("{")) {
          resolve("登录有效");
          return;
        }
        resolve("登录已失效，请重新登录 OA");
      });
    });
    req.on("error", (err) => resolve(`请求失败：${err.message}`));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve("请求超时");
    });
    req.end();
  });
}

/**
 * 根据用户发送的文本内容决定回复内容（可在此扩展更多指令）
 * @param {string} rawText - 用户消息原文
 * @param {{ larkClient: import('@larksuiteoapi/node-sdk').Client; receiveId: string; receiveIdType: string; requestOptions?: unknown } | null} [feishuContext] - 飞书上下文，用于上传验证码图片并发送
 * @returns {Promise<{ text: string }>} - 用于 text 消息的 content
 */
async function getReplyByContent(rawText, feishuContext) {
  const text = (rawText || "").trim();
  const lower = text.toLowerCase();

  if (lower && lower.includes("登录")) {
    const result = await loginHandler();
    if (result === "登录有效") {
      return { text: "登录成功" };
    }
    const verifyMsg = await reloginHandler(feishuContext ?? null);
    return { text: `${result}\n${verifyMsg}` };
  }

  // 如果输入的是4位验证码，则调用登录接口
  console.log("lower", lower.length);
  if (lower && lower.length === 4) {
    const result = await loginWithVerifyCodeHandler(lower);
    return { text: result };
  }

  if (lower && lower === "答题") {
    const result = await answerQuestionHandler();
    return { text: result };
  }
}

/** 从 cookie 字符串中解析出指定 name 的值 */
function getCookieValue(cookieStr, name) {
  if (!cookieStr || !name) return null;
  const parts = cookieStr.split(";").map((s) => s.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** bmtopic/get 请求头（与浏览器一致） */
const OA_BMTOPIC_GET_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  Connection: "keep-alive",
  Referer:
    "https://oa.teligen-cloud.com:8280/meip/view/bmtopic/bmtopic.html",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/144.0.0.0",
  "X-Requested-With": "XMLHttpRequest",
};

/** bmtopic/saveAnswer 请求头 */
const OA_BMTOPIC_SAVE_ANSWER_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  Connection: "keep-alive",
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: "https://oa.teligen-cloud.com:8280",
  Referer:
    "https://oa.teligen-cloud.com:8280/meip/view/bmtopic/bmtopic.html",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/144.0.0.0",
  "X-Requested-With": "XMLHttpRequest",
};

/**
 * 根据 bmtopic/get 返回的题目对象构造 saveAnswer 的 application/x-www-form-urlencoded 请求体
 * @param {Record<string, unknown>} topic - get 接口返回的题目 JSON
 * @returns {string}
 */
function buildSaveAnswerBody(topic) {
  const enc = encodeURIComponent;
  const str = (v) => (v == null ? "null" : String(v));
  const orderKey =
    topic.orderKey != null
      ? Number(topic.orderKey) === topic.orderKey
        ? String(Math.floor(topic.orderKey))
        : str(topic.orderKey)
      : "";
  const params = new URLSearchParams();
  params.set("answerTitle", "提交");
  params.set("commitText", str(topic.answer ?? ""));
  params.set("topic", str(topic.topic ?? ""));
  params.set("type", str(topic.type ?? ""));
  params.set("topicId", str(topic.id ?? ""));
  params.set("orderKey", orderKey);
  params.set("analysis", str(topic.analysis ?? ""));
  params.set("answer", str(topic.answer ?? ""));
  params.set("aOption", str(topic.aOption ?? ""));
  params.set("bOption", str(topic.bOption ?? ""));
  params.set("cOption", str(topic.cOption ?? ""));
  params.set("dOption", str(topic.dOption ?? ""));
  params.set("eOption", str(topic.eOption ?? ""));
  params.set("fOption", str(topic.fOption ?? ""));
  params.set("gOption", str(topic.gOption ?? ""));
  params.set("hOption", topic.hOption == null ? "null" : str(topic.hOption));
  params.set("iOption", topic.iOption == null ? "null" : str(topic.iOption));
  params.set("jOption", topic.jOption == null ? "null" : str(topic.jOption));
  return params.toString();
}

/**
 * 调用 OA bmtopic/saveAnswer 提交答案
 * @param {Record<string, unknown>} topic - bmtopic/get 返回的题目对象
 * @param {string} cookieStr - 完整 Cookie 字符串
 * @param {string|null} aaaaa - aaaaa 令牌
 * @returns {Promise<string>} 成功返回「已自动提交」，失败抛出或返回说明
 */
function saveAnswerRequest(topic, cookieStr, aaaaa) {
  return new Promise((resolve, reject) => {
    const body = buildSaveAnswerBody(topic);
    const url = new URL(OA_BMTOPIC_SAVE_ANSWER_URL);
    const headers = {
      ...OA_BMTOPIC_SAVE_ANSWER_HEADERS,
      Cookie: cookieStr,
      "Content-Length": Buffer.byteLength(body, "utf8"),
    };
    if (aaaaa) headers.aaaaa = aaaaa;

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers,
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          resolve(`提交接口 HTTP ${res.statusCode}：${raw.slice(0, 200)}`);
          return;
        }
        let json;
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch (_) {
          resolve("提交成功（返回非 JSON）");
          return;
        }
        if (json.isRight === "10") {
          resolve("已自动提交");
          return;
        }
        resolve(
          "今日已答题，无需重复提交" + (json.msg ?? json.message ?? JSON.stringify(json)),
        );
      });
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("提交超时"));
    });
    req.write(body, "utf8");
    req.end();
  });
}

/**
 * 请求 OA 答题接口 bmtopic/get 获取题目/答案；需已登录（cookie 含 JSESSIONID、aaaaa）。
 * 若返回题目含 id 与 answer，会再调用 saveAnswer 自动提交答案。
 * @returns {Promise<string>} 成功返回格式化后的题目与答案及提交结果，失败返回原因说明
 */
async function answerQuestionHandler() {
  let cookieStr = "";
  try {
    await fs.access(OA_COOKIE_FILE);
    cookieStr = (await fs.readFile(OA_COOKIE_FILE, "utf8")) || "";
  } catch (e) {
    if (e.code === "ENOENT") return "请先发送「登录」完成 OA 登录后再答题";
    console.error("读取 cookie 失败：", e);
    return "读取 cookie 失败";
  }
  cookieStr = cookieStr.trim();
  if (!cookieStr) return "无有效 cookie，请先发送「登录」完成 OA 登录";

  const aaaaa = getCookieValue(cookieStr, "aaaaa");
  const headers = {
    ...OA_BMTOPIC_GET_HEADERS,
    Cookie: cookieStr,
  };
  if (aaaaa) headers.aaaaa = aaaaa;

  return new Promise((resolve) => {
    const url = new URL(OA_BMTOPIC_GET_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "GET",
      headers,
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(`答题接口请求失败（HTTP ${res.statusCode}）`);
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(raw);
        } catch (_) {
          resolve("答题接口返回非 JSON");
          return;
        }
        const answer = json.answer ?? json.status;
        const answerText = "今日答案：" + answer;

        if (json.id && json.answer != null) {
          saveAnswerRequest(json, cookieStr, aaaaa)
            .then((saveResult) => resolve(answerText + "\n" + saveResult))
            .catch((err) =>
              resolve(answerText + "\n提交答案失败：" + err.message),
            );
        } else {
          resolve(answerText);
        }
      });
    });
    req.on("error", (err) => resolve("答题请求失败：" + err.message));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve("答题请求超时");
    });
    req.end();
  });
}

/** validLogin 请求头（与浏览器一致） */
const OA_VALID_LOGIN_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  Connection: "keep-alive",
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: "https://oa.teligen-cloud.com:8280",
  Referer:
    "https://oa.teligen-cloud.com:8280/meip/view/login/login.html",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/144.0.0.0",
  "X-Requested-With": "XMLHttpRequest",
  aaaaa: "null",
};

/**
 * 使用验证码调用 OA validLogin 接口登录；账号、密码从环境变量 OA_ACCOUNT、OA_PASSWORD 读取（密码可为明文或与前端一致的加密串）。
 * @param {string} verifyCode - 4 位验证码
 * @returns {Promise<string>} 成功返回「登录有效」，失败返回原因说明
 */
async function loginWithVerifyCodeHandler(verifyCode) {
  const account = process.env.OA_ACCOUNT;
  const password = process.env.OA_PASSWORD;
  if (!account || !password) {
    return "未配置 OA_ACCOUNT 或 OA_PASSWORD 环境变量";
  }

  let cookieStr = "";
  try {
    await fs.access(OA_COOKIE_FILE);
    cookieStr = (await fs.readFile(OA_COOKIE_FILE, "utf8")) || "";
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("读取 cookie 文件失败：", e);
      return "读取 cookie 失败，请先发送「登录」获取验证码";
    }
  }
  cookieStr = cookieStr.trim();
  if (!cookieStr) {
    return "无有效 cookie，请先发送「登录」获取验证码后再输入验证码";
  }

  const body = new URLSearchParams({
    account,
    password,
    mxAccount: "null",
    imgCode: (verifyCode || "").trim(),
  }).toString();

  return new Promise((resolve) => {
    const url = new URL(OA_VALID_LOGIN_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        ...OA_VALID_LOGIN_HEADERS,
        Cookie: cookieStr,
        "Content-Length": Buffer.byteLength(body, "utf8"),
      },
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", async () => {
        if (res.statusCode !== 200) {
          resolve(`登录请求失败（HTTP ${res.statusCode}）`);
          return;
        }
        const setCookie = res.headers["set-cookie"];
        if (setCookie && setCookie.length) {
          try {
            await fs.writeFile(OA_COOKIE_FILE, setCookie.join("; ") + ";" + cookieStr);
            console.log("loginWithVerifyCodeHandler cookieStr", cookieStr);
            console.log("loginWithVerifyCodeHandler setCookie", setCookie);
          } catch (e) {
            console.error("写入 cookie 失败：", e);
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(raw);
        } catch (_) {
          resolve("登录接口返回非 JSON");
          return;
        }
        console.log("loginWithVerifyCodeHandler json", json);
        // 常见成功：code 0 或 success true；失败：code 非 0 或 message
        const code = json.result ?? json.status;
        const success = json.success === true || code === 0 || code === "0";
        if (success) {
          resolve("登录有效");
          return;
        }
        const msg = json.message ?? json.msg ?? json.error ?? raw;
        resolve("登录失败：" + (typeof msg === "string" ? msg : JSON.stringify(msg)));
      });
    });
    req.on("error", (err) => resolve("登录请求失败：" + err.message));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve("登录请求超时");
    });
    req.write(body, "utf8");
    req.end();
  });
}

/** 请求 OA 验证码图片接口使用的请求头（与浏览器一致） */
const OA_VERIFY_CODE_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  Connection: "keep-alive",
  Referer:
    "https://oa.teligen-cloud.com:8280/meip/view/login/login.html?userId=null",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36 Edg/144.0.0.0",
  "X-Requested-With": "XMLHttpRequest",
  aaaaa: "null",
  "sec-ch-ua":
    '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
};

/**
 * 通过 POST 请求获取 OA 验证码图片；若传入飞书上下文则上传飞书并发送图片消息，否则保存到本地。
 * @param {{ larkClient: import('@larksuiteoapi/node-sdk').Client; receiveId: string; receiveIdType: string; requestOptions?: unknown } | null} [feishuContext] - 飞书上下文，用于上传并发送图片消息
 * @returns {Promise<string>} 成功返回说明文案，失败返回错误信息
 */
async function reloginHandler(feishuContext) {
  return new Promise((resolve) => {
    resolve("验证码获取失败，请重新登录 OA");
    const url = new URL(OA_VERIFY_CODE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: OA_VERIFY_CODE_HEADERS,
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", async () => {
        if (res.statusCode !== 200) {
          resolve(`验证码获取失败（HTTP ${res.statusCode}）`);
          return;
        }
        // 获取set-cookie中的JSESSIONID
        const cookies = res.headers["set-cookie"];
        if (cookies) {
          console.log("cookies", cookies);
          // 写入cookie文件
          await fs.writeFile(OA_COOKIE_FILE, cookies.join("; "));
          console.log("cookie文件写入成功");
        }
        const contentType = (res.headers["content-type"] || "").toLowerCase();
        const body = Buffer.concat(chunks);
        let imageBuffer = null;
        if (contentType.includes("application/json")) {
          try {
            const json = JSON.parse(body.toString("utf8"));
            const base64 = json.png_base64;
            console.log("验证码接口返回数据：", json);
            if (base64) imageBuffer = Buffer.from(base64.slice(22), "base64");
          } catch (_) {
            console.error(
              "解析验证码接口返回数据失败：",
              body.toString("utf8"),
            );
            resolve("验证码接口返回数据解析失败");
            return;
          }
        }
        if (!imageBuffer && (contentType.includes("image/") || body.length > 0))
          imageBuffer = body;
        if (!imageBuffer) {
          resolve("验证码接口返回格式未知");
          return;
        }
        (async () => {
          if (feishuContext?.larkClient && feishuContext?.receiveId) {
            console.log("开始上传验证码图片到飞书");
            const token = await getTenantAccessToken();
            if (!token) {
              resolve("验证码已获取，但飞书 token 获取失败");
              return;
            }
            console.log("飞书 token 获取成功，开始上传验证码图片到飞书");
            const imageKey = await uploadImageToFeishu(token, imageBuffer);
            if (!imageKey) {
              resolve("验证码已获取，但上传飞书失败");
              return;
            }
            try {
              await feishuContext.larkClient.im.message.create(
                {
                  params: { receive_id_type: feishuContext.receiveIdType },
                  data: {
                    receive_id: feishuContext.receiveId,
                    msg_type: "image",
                    content: JSON.stringify({ image_key: imageKey }),
                  },
                },
                feishuContext.requestOptions,
              );
              resolve("已获取验证码并已发送至当前会话");
            } catch (e) {
              resolve(
                "验证码已获取并已上传，但发送消息失败：" +
                  (e.message || String(e)),
              );
            }
            return;
          }
          try {
            await fs.writeFile(OA_VERIFY_CODE_IMAGE_PATH, imageBuffer);
            // resolve(`验证码已获取并保存至 ${OA_VERIFY_CODE_IMAGE_PATH}`);
          } catch (e) {
            resolve("验证码保存失败：" + (e.message || String(e)));
          }
        })().catch((e) => resolve("处理失败：" + (e.message || String(e))));
      });
    });
    req.on("error", (err) => resolve(`验证码请求失败：${err.message}`));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve("验证码请求超时");
    });
    req.end();
  });
}

/** 仅用 JSON 字符串写响应，避免 res.json() 导致 BOM/多余内容，满足飞书「合法 JSON」校验 */
function replyJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  res.status(statusCode).end(body);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    replyJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  let body = req.body;
  if (!body || typeof body !== "object") {
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : {};
    } catch {
      body = {};
    }
  }

  // 1. URL 校验（飞书文档：type=url_verification 或 顶层含 challenge）
  const isUrlVerification =
    body.type === "url_verification" ||
    (body.challenge != null && body.challenge !== "") ||
    (body.CHALLENGE != null && body.CHALLENGE !== "");
  const challenge = body.challenge ?? body.CHALLENGE ?? "";

  if (isUrlVerification && challenge !== "") {
    replyJson(res, 200, { challenge: String(challenge) });
    return;
  }

  if (!larkClient) {
    console.error("APP_ID or APP_SECRET not configured");
    replyJson(res, 500, { error: "Server configuration error" });
    return;
  }

  // 2. 事件回调：im.message.receive_v1
  const header = body.header || {};
  const event = body.event || {};

  if (header.event_type === "im.message.receive_v1") {
    try {
      const message = event.message || {};
      const chatType = message.chat_type || "";
      const chatId = message.chat_id;
      // 单聊(p2p) 时发消息需用 open_id；群聊用 chat_id（见飞书文档 230034 / 发送消息）
      const sender = event.sender || {};
      let senderId = sender.sender_id || sender.open_id || message.sender_id;
      // 飞书事件里 sender_id 可能是对象 { open_id, union_id, user_id }，receive_id 必须是字符串
      if (senderId && typeof senderId === "object" && senderId.open_id) {
        senderId = senderId.open_id;
      }
      console.log("sender", sender);
      const content = message.content ? JSON.parse(message.content) : {};
      const userText = content.text || "";
      const isP2p = String(chatType).toLowerCase() === "p2p";
      const receiveIdType = isP2p ? "open_id" : "chat_id";
      const receiveId = isP2p ? senderId : chatId;
      const tenantKey = header.tenant_key;
      const requestOptions = tenantKey ? withTenantKey(tenantKey) : undefined;
      const feishuContext = receiveId
        ? { larkClient, receiveId, receiveIdType, requestOptions }
        : null;
      const replyContent = await getReplyByContent(userText, feishuContext);
      // 飞书发送消息接口要求 content 为 JSON 字符串，不能传对象
      const reply = {
        msg_type: "text",
        content: JSON.stringify(replyContent),
      };

      if (!receiveId) {
        console.error(
          "Process message: missing receive_id (open_id or chat_id)",
        );
      } else {
        await larkClient.im.message.create(
          {
            params: { receive_id_type: receiveIdType },
            data: { receive_id: receiveId, ...reply },
          },
          requestOptions,
        );
      }
    } catch (err) {
      console.error("Process message error:", err);
      if (err.response?.data)
        console.error("Feishu API response:", err.response.data);
      // 仍返回 200，避免飞书重复推送
    }
  }

  // 其他事件或处理完毕，均返回 200（飞书要求 3 秒内 200），且必须为合法 JSON
  replyJson(res, 200, {});
};
