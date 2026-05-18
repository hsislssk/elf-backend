const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---- 环境变量 ----
const BAIDU_AK = process.env.BAIDU_AK;
const BAIDU_SK = process.env.BAIDU_SK;
const TENCENT_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_KEY = process.env.TENCENT_SECRET_KEY;
const XF_APPID = process.env.XF_APPID;
const XF_API_KEY = process.env.XF_API_KEY;
const XF_API_SECRET = process.env.XF_API_SECRET;
const WEATHER_KEY = process.env.WEATHER_KEY;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;

cloudinary.config({ cloud_name: CLOUD_NAME, api_key: CLOUD_KEY, api_secret: CLOUD_SECRET });

// 腾讯混元3D
const tencentcloud = require("tencentcloud-sdk-nodejs");
const HunyuanClient = tencentcloud.hunyuan.v20230901.Client;
const hunyuan = new HunyuanClient({
  credential: { secretId: TENCENT_ID, secretKey: TENCENT_KEY },
  region: "ap-beijing",
  profile: { httpProfile: { endpoint: "hunyuan.tencentcloudapi.com" } }
});

const jobs = new Map();

// ---- 百度识图（分析手机壳风格）----
async function analyzeImage(base64) {
  const tokenRes = await axios.post('https://aip.baidubce.com/oauth/2.0/token', null, {
    params: { grant_type: 'client_credentials', client_id: BAIDU_AK, client_secret: BAIDU_SK }
  });
  const token = tokenRes.data.access_token;
  const res = await axios.post(
    `https://aip.baidubce.com/rest/2.0/image-classify/v2/advanced_general?access_token=${token}`,
    { image: base64 }
  );
  const keywords = (res.data.result || []).map(i => i.keyword).join(',');
  let style = '甜心萝莉', hair = '#ffb8c6', outfit = '连衣裙';
  if (keywords.includes('西装')) { style = '高冷御姐'; hair = '#c8b8e8'; outfit = '西装裙'; }
  else if (keywords.includes('黑色') || keywords.includes('酷')) { style = '清冷少年'; hair = '#88aadd'; outfit = '卫衣'; }
  else if (keywords.includes('紫色') || keywords.includes('星空')) { style = '神秘精灵'; hair = '#d4c5f9'; outfit = '法师袍'; }
  return { style, hair, outfit };
}

// ---- 混元3D生成 ----
async function submit3DJob(prompt, base64) {
  const res = await hunyuan.SubmitHunyuanTo3DProJob({
    Prompt: prompt,
    ImageBase64: base64,
    Style: "cartoon_q_version",
    OutputFormat: "GLB"
  });
  return res.JobId;
}

async function check3DJob(jobId) {
  return await hunyuan.DescribeHunyuanTo3DProJob({ JobId: jobId });
}

async function saveToCloudinary(url) {
  const result = await cloudinary.uploader.upload(url, {
    resource_type: "raw", folder: "elf_models", use_filename: true, unique_filename: true
  });
  return result.secure_url;
}

// ---- 讯飞星火对话 ----
function sparkChat(message, style) {
  return new Promise((resolve, reject) => {
    const host = 'spark-api.xf-yun.com';
    const date = new Date().toUTCString();
    const requestLine = 'GET /v4.0/chat HTTP/1.1';
    const signStr = `host: ${host}\ndate: ${date}\n${requestLine}`;
    const hmac = crypto.createHmac('sha256', XF_API_SECRET);
    hmac.update(signStr);
    const sig = hmac.digest('base64');
    const authOrigin = `api_key="${XF_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`;
    const auth = Buffer.from(authOrigin).toString('base64');
    const wsUrl = `wss://${host}/v4.0/chat?authorization=${encodeURIComponent(auth)}&date=${encodeURIComponent(date)}&host=${host}`;

    const ws = new WebSocket(wsUrl);
    let result = '', done = false;
    let system = '你是可爱的二次元精灵，说话软萌。';
    if (style === '高冷御姐') system = '你是高冷御姐，语气简洁。';
    else if (style === '清冷少年') system = '你是温柔少年，语气安静。';

    ws.onopen = () => ws.send(JSON.stringify({
      header: { app_id: XF_APPID },
      parameter: { chat: { domain: '4.0Ultra', temperature: 0.8, max_tokens: 200 } },
      payload: { message: { text: [{ role: 'system', content: system }, { role: 'user', content: message }] } }
    }));
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data.toString());
      if (d.header.code !== 0) { reject(new Error(d.header.message)); return; }
      if (d.payload?.choices) {
        result += d.payload.choices.text.map(c => c.content).join('');
        if (d.header.status === 2 && !done) { done = true; resolve(result); ws.close(); }
      }
    };
    ws.onerror = reject;
    ws.onclose = () => { if (!done) reject(new Error('closed')); };
    setTimeout(() => { if (!done) reject(new Error('timeout')); }, 15000);
  });
}

// ---- 讯飞TTS（情感语音）----
function getVoice(style) {
  const map = { '甜心萝莉':'xiaoqi','高冷御姐':'xiaoyan','清冷少年':'xiaofeng','阳光元气':'xiaomeng','神秘精灵':'xiaojing','古风雅韵':'xiaomei' };
  return map[style] || 'xiaoyan';
}

async function getTTS(text, style) {
  const host = 'tts-api.xfyun.cn';
  const date = new Date().toUTCString();
  const requestLine = 'GET /v2/tts HTTP/1.1';
  const signStr = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const hmac = crypto.createHmac('sha256', XF_API_SECRET);
  hmac.update(signStr);
  const sig = hmac.digest('base64');
  const authOrigin = `api_key="${XF_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`;
  const auth = Buffer.from(authOrigin).toString('base64');
  const url = `https://${host}/v2/tts`;
  const body = {
    common: { app_id: XF_APPID },
    business: { aue: 'lame', sfl: 1, auf: 'audio/L16;rate=16000', vcn: getVoice(style), speed: 50, volume: 50, pitch: 50, tte: 'UTF8' },
    data: { status: 2, text: Buffer.from(text).toString('base64') }
  };
  const resp = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth}`, 'date': date, 'host': host },
    responseType: 'arraybuffer'
  });
  return `data:audio/mp3;base64,${Buffer.from(resp.data).toString('base64')}`;
}

// ---- API ----
app.post('/api/generate-elf', upload.single('photo'), async (req, res) => {
  try {
    const base64 = req.file.buffer.toString('base64');
    const persona = await analyzeImage(base64);
    const prompt = `一个${persona.style}风格的Q版3D二次元精灵，${persona.hair}头发，穿着${persona.outfit}，纯色背景`;
    const jobId = await submit3DJob(prompt, base64);
    jobs.set(jobId, { persona, status: 'PROCESSING' });
    res.json({ success: true, jobId });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/check-job', async (req, res) => {
  const { jobId } = req.query;
  if (!jobs.has(jobId)) return res.json({ status: 'NOT_FOUND' });
  try {
    const result = await check3DJob(jobId);
    if (result.Status === 'SUCCESS') {
      const permUrl = await saveToCloudinary(result.ResultUrl);
      jobs.get(jobId).modelUrl = permUrl;
      res.json({ status: 'SUCCESS', modelUrl: permUrl, persona: jobs.get(jobId).persona });
    } else if (result.Status === 'FAILED') {
      jobs.delete(jobId);
      res.json({ status: 'FAILED' });
    } else {
      res.json({ status: 'PROCESSING' });
    }
  } catch(e) {
    res.json({ status: 'ERROR' });
  }
});

app.post('/api/ai-chat', async (req, res) => {
  try {
    const reply = await sparkChat(req.body.message, req.body.style);
    res.json({ reply: reply.replace(/[*#\[\]]/g, '') });
  } catch(e) {
    res.json({ reply: '信号不太好，再说一次吧~' });
  }
});

app.get('/api/tts', async (req, res) => {
  try {
    const audio = await getTTS(req.query.text, req.query.style);
    res.json({ audioUrl: audio });
  } catch(e) {
    res.json({ audioUrl: '' });
  }
});

app.get('/api/weather', async (req, res) => {
  try {
    const r = await axios.get(`https://devapi.qweather.com/v7/weather/now?key=${WEATHER_KEY}&location=auto`);
    res.json({ text: r.data.now.text, temp: r.data.now.temp });
  } catch(e) { res.json({ text: '晴', temp: '22' }); }
});

app.get('/api/fortune', (req, res) => {
  const f = ['大吉','吉','中吉','小吉'][Math.floor(Math.random()*4)];
  res.json({ text: `今日运势：${f}！` });
});

module.exports = app;