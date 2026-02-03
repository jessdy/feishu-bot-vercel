/**
 * 飞书消息机器人 Webhook 处理逻辑
 * 由 server.js 挂载到 POST /api/feishu（PM2 运行）
 *
 * 飞书文档：请求地址校验需在 1 秒内返回 HTTP 200，响应体为 JSON 且包含 challenge 字段。
 * 未配置 Encrypt Key 时请求体为 {"type":"url_verification","challenge":"xxx"} 或 {"challenge":"xxx"}。
 * 配置了 Encrypt Key 时请求体为 {"encrypt":"..."}，需先解密再取 challenge（当前未实现解密）。
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { Client, withTenantKey } = require('@larksuiteoapi/node-sdk');

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
const OA_COOKIE_FILE = process.env.OA_COOKIE_FILE || path.join(process.cwd(), '.oa-cookie');
const OA_LOGIN_CHECK_URL = 'https://oa.teligen-cloud.com:8280/meip/loginController/getLoginInfo';
const OA_VERIFY_CODE_URL = 'https://oa.teligen-cloud.com:8280/meip/loginController/verifyCode/ImageCode';
const OA_VERIFY_CODE_IMAGE_PATH = path.join(process.cwd(), '.oa-verify-code.png');

/** 飞书上传图片并获取 image_key（用于发送图片消息） */
const FEISHU_IMAGES_URL = 'https://open.feishu.cn/open-apis/im/v1/images';
const FEISHU_IMAGE_TYPE = 'message';

/**
 * 获取飞书 tenant_access_token（用于上传图片等 Open API）
 * @returns {Promise<string|null>}
 */
async function getTenantAccessToken() {
  if (!APP_ID || !APP_SECRET) return null;
  const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
    body,
  });
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
  form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'verify.png');
  form.append('image_type', FEISHU_IMAGE_TYPE);
  const res = await fetch(FEISHU_IMAGES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json();
  console.log('上传验证码图片到飞书成功，返回数据：', json);
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
      if (e.code === 'ENOENT') await fs.writeFile(OA_COOKIE_FILE, '');
    }
    cookieStr = await fs.readFile(OA_COOKIE_FILE, 'utf8');
  } catch (e) {
    console.error('读取 cookie 文件失败：', e);
    if (e.code === 'ENOENT') return '未找到 cookie 文件，请先配置 .oa-cookie 或 OA_COOKIE_FILE';
    throw e;
  }
  cookieStr = (cookieStr || '').trim();
  if (!cookieStr) {
    return await reloginHandler();
  }

  return new Promise((resolve) => {
    const url = new URL(OA_LOGIN_CHECK_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { Cookie: cookieStr },
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(`登录已失效（HTTP ${res.statusCode}）`);
          return;
        }
        // 登录页会包含「登 录」「温馨提示」等文案，有用户信息或非登录页则视为有效
        if (body && body.startsWith("{")) {
          resolve('登录已失效，请重新登录 OA');
          return;
        }
        resolve('登录有效');
      });
    });
    req.on('error', (err) => resolve(`请求失败：${err.message}`));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve('请求超时');
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
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  if (lower && lower.includes('登录')) {
    const result = await loginHandler();
    if (result === '登录有效') {
      return { text: '登录成功' };
    }
    const verifyMsg = await reloginHandler(feishuContext ?? null);
    return { text: `${result}\n${verifyMsg}` };
  }

  if (lower === '帮助' || lower === 'help') {
    return {
      text: '可用指令：\n• 帮助 / help - 显示本说明\n• ping - 测活\n• 其他内容 - 原样回显',
    };
  }
  if (lower === 'ping') {
    return { text: 'pong' };
  }
  if (text) {
    return { text: `你说了：${text}` };
  }
  return { text: '（空）' };
}

/** 请求 OA 验证码图片接口使用的请求头（与浏览器一致） */
const OA_VERIFY_CODE_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Connection: 'keep-alive',
  Referer: 'https://oa.teligen-cloud.com:8280/meip/view/login/login.html?userId=null',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36 Edg/144.0.0.0',
  'X-Requested-With': 'XMLHttpRequest',
  aaaaa: 'null',
  'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
};

/**
 * 通过 POST 请求获取 OA 验证码图片；若传入飞书上下文则上传飞书并发送图片消息，否则保存到本地。
 * @param {{ larkClient: import('@larksuiteoapi/node-sdk').Client; receiveId: string; receiveIdType: string; requestOptions?: unknown } | null} [feishuContext] - 飞书上下文，用于上传并发送图片消息
 * @returns {Promise<string>} 成功返回说明文案，失败返回错误信息
 */
async function reloginHandler(feishuContext) {
  return new Promise((resolve) => {
    const url = new URL(OA_VERIFY_CODE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: OA_VERIFY_CODE_HEADERS,
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(`验证码获取失败（HTTP ${res.statusCode}）`);
          return;
        }
        const contentType = (res.headers['content-type'] || '').toLowerCase();
        const body = Buffer.concat(chunks);
        let imageBuffer = null;
        if (contentType.includes('application/json')) {
          try {
            const json = JSON.parse(body.toString('utf8'));
            const base64 = json.png_base64;
            console.log('验证码接口返回数据：', json);
            if (base64) imageBuffer = Buffer.from(base64.slice(4), 'base64');
            console.log('验证码图片二进制：', base64.slice(4));
          } catch (_) {
            console.error('解析验证码接口返回数据失败：', body.toString('utf8'));
            resolve('验证码接口返回数据解析失败');
            return;
          }
        }
        if (!imageBuffer && (contentType.includes('image/') || body.length > 0)) imageBuffer = body;
        if (!imageBuffer) {
          resolve('验证码接口返回格式未知');
          return;
        }
        (async () => {
          if (feishuContext?.larkClient && feishuContext?.receiveId) {
            console.log('开始上传验证码图片到飞书');
            const token = await getTenantAccessToken();
            if (!token) {
              resolve('验证码已获取，但飞书 token 获取失败');
              return;
            }
            console.log('飞书 token 获取成功，开始上传验证码图片到飞书');
            const imageKey = await uploadImageToFeishu(token, imageBuffer);
            if (!imageKey) {
              resolve('验证码已获取，但上传飞书失败');
              return;
            }
            try {
              await feishuContext.larkClient.im.message.create(
                {
                  params: { receive_id_type: feishuContext.receiveIdType },
                  data: {
                    receive_id: feishuContext.receiveId,
                    msg_type: 'image',
                    content: JSON.stringify({ image_key: imageKey }),
                  },
                },
                feishuContext.requestOptions
              );
              resolve('已获取验证码并已发送至当前会话');
            } catch (e) {
              resolve('验证码已获取并已上传，但发送消息失败：' + (e.message || String(e)));
            }
            return;
          }
          try {
            await fs.writeFile(OA_VERIFY_CODE_IMAGE_PATH, imageBuffer);
            resolve(`验证码已获取并保存至 ${OA_VERIFY_CODE_IMAGE_PATH}`);
          } catch (e) {
            resolve('验证码保存失败：' + (e.message || String(e)));
          }
        })().catch((e) => resolve('处理失败：' + (e.message || String(e))));
      });
    });
    req.on('error', (err) => resolve(`验证码请求失败：${err.message}`));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve('验证码请求超时');
    });
    req.end();
  });
}

/** 仅用 JSON 字符串写响应，避免 res.json() 导致 BOM/多余内容，满足飞书「合法 JSON」校验 */
function replyJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.status(statusCode).end(body);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    replyJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : {};
    } catch {
      body = {};
    }
  }

  // 1. URL 校验（飞书文档：type=url_verification 或 顶层含 challenge）
  const isUrlVerification =
    body.type === 'url_verification' ||
    (body.challenge != null && body.challenge !== '') ||
    (body.CHALLENGE != null && body.CHALLENGE !== '');
  const challenge = body.challenge ?? body.CHALLENGE ?? '';

  if (isUrlVerification && challenge !== '') {
    replyJson(res, 200, { challenge: String(challenge) });
    return;
  }

  if (!larkClient) {
    console.error('APP_ID or APP_SECRET not configured');
    replyJson(res, 500, { error: 'Server configuration error' });
    return;
  }

  // 2. 事件回调：im.message.receive_v1
  const header = body.header || {};
  const event = body.event || {};

  if (header.event_type === 'im.message.receive_v1') {
    try {
      const message = event.message || {};
      const chatType = message.chat_type || '';
      const chatId = message.chat_id;
      // 单聊(p2p) 时发消息需用 open_id；群聊用 chat_id（见飞书文档 230034 / 发送消息）
      const sender = event.sender || {};
      let senderId = sender.sender_id || sender.open_id || message.sender_id;
      // 飞书事件里 sender_id 可能是对象 { open_id, union_id, user_id }，receive_id 必须是字符串
      if (senderId && typeof senderId === 'object' && senderId.open_id) {
        senderId = senderId.open_id;
      }

      const content = message.content ? JSON.parse(message.content) : {};
      const userText = content.text || '';
      const isP2p = String(chatType).toLowerCase() === 'p2p';
      const receiveIdType = isP2p ? 'open_id' : 'chat_id';
      const receiveId = isP2p ? senderId : chatId;
      const tenantKey = header.tenant_key;
      const requestOptions = tenantKey ? withTenantKey(tenantKey) : undefined;
      const feishuContext = receiveId
        ? { larkClient, receiveId, receiveIdType, requestOptions }
        : null;
      const replyContent = await getReplyByContent(userText, feishuContext);
      // 飞书发送消息接口要求 content 为 JSON 字符串，不能传对象
      const reply = {
        msg_type: 'text',
        content: JSON.stringify(replyContent),
      };

      if (!receiveId) {
        console.error('Process message: missing receive_id (open_id or chat_id)');
      } else {
        await larkClient.im.message.create(
          {
            params: { receive_id_type: receiveIdType },
            data: { receive_id: receiveId, ...reply },
          },
          requestOptions
        );
      }
    } catch (err) {
      console.error('Process message error:', err);
      if (err.response?.data) console.error('Feishu API response:', err.response.data);
      // 仍返回 200，避免飞书重复推送
    }
  }

  // 其他事件或处理完毕，均返回 200（飞书要求 3 秒内 200），且必须为合法 JSON
  replyJson(res, 200, {});
};
