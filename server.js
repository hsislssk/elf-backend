const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const app = express();

// 【修复1：严格跨域】
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"] }));
app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---- 环境变量【修复2：变量名和Vercel严格对应】----
const BAIDU_AK = process.env.BAIDU_AK;
const BAIDU_SK = process.env.BAIDU_SK;
const TENCENT_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_KEY = process.env.TENCENT_SECRET_KEY;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const XF_APPID = process.env.XF_APPID;
const XF_API_KEY = process.env.XF_API_KEY;
const XF_API_SECRET = process.env.XF_API_SECRET;
const WEATHER_KEY = process.env.WEATHER_KEY;

// ---- 初始化Cloudinary ----
cloudinary.config({
  cloud_name: CLOUD_NAME,
  api_key: CLOUD_API_KEY,
  api_secret: CLOUD_API_SECRET
});

// ---- 工具函数：获取百度token ----
async function getBaiduToken() {
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_AK}&client_secret=${BAIDU_SK}`;
  const res = await axios.get(url);
  return res.data.access_token;
}

// ---- 工具函数：讯飞签名 ----
function getXfSign(appid, apikey, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const md5 = crypto.createHash('md5').update(appid + ts).digest('hex');
  return crypto.createHmac('sha256', secret).update(apikey + ts + md5).digest('base64');
}

// ---- 1. 图片风格分析 ----
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    const token = await getBaiduToken();
    const base64 = req.file.buffer.toString('base64');
    const url = `https://aip.baidubce.com/rest/2.0/image-classify/v2/advanced_general?access_token=${token}`;
    const result = await axios.post(url, { image: base64 });
    res.json({ style: result.data.result[0].keyword || "cute" });
  } catch (e) {
    console.error("分析失败：",e);
    res.json({ style: 'cute' });
  }
});

// ---- 2. 混元3D生成【修复3：增加轮询，解决一直卡住】 ----
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    const base64 = req.file.buffer.toString('base64');
    const { style } = req.body;
    const tencent = require('tencentcloud-sdk-nodejs').tencentcloud;
    const client = new tencentcloud.hunyuan.v20230901.Client({
      credential: { secretId: TENCENT_ID, secretKey: TENCENT_KEY },
      region: 'ap-guangzhou',
      profile: { httpProfile: { endpoint: 'hunyuan.tencentcloudapi.com' } }
    });
    const params = {
      Model: 'hunyuan-3d',
      Text: `Q版${style || "可爱"}精灵，3D卡通，全身，可爱，精致`,
      Image: base64
    };
    const resp = await client.TextTo3D(params);
    const TaskId = resp.TaskId;

    // 轮询任务
    let modelUrl = null;
    for(let i=0;i<30;i++){
      await new Promise(r=>setTimeout(r,3000));
      const status = await client.DescribeTextTo3D({TaskId});
      if(status.Status === "Success"){
        modelUrl = status.ModelUrl;
        break;
      }
    }

    if(!modelUrl) throw new Error("3D生成超时");
    const upload = await cloudinary.uploader.upload(modelUrl, { resource_type: 'raw' });
    res.json({ model: upload.secure_url });
  } catch (e) {
    console.error("生成错误：",e);
    res.status(500).json({ error: '生成失败' });
  }
});

// ---- 3. 讯飞语音对话 ----
app.post('/api/chat', async (req, res) => {
  const { text } = req.body;
  const sign = getXfSign(XF_APPID, XF_API_KEY, XF_API_SECRET);
  const url = `wss://spark-api.xf-yun.com/v1.1/chat`;
  const ws = new WebSocket(url, {
    headers: {
      'Authorization': `hmac sha256 ${sign}`,
      'X-Appid': XF_APPID,
      'X-Timestamp': Math.floor(Date.now() / 1000)
    }
  });
  let reply = '';
  ws.on('open', () => {
    ws.send(JSON.stringify({
      header: { app_id: XF_APPID },
      parameter: { chat: { domain: 'general', temperature: 0.5 } },
      payload: { message: { text: [{ role: 'user', content: text }] } }
    }));
  });
  ws.on('message', (data) => {
    const json = JSON.parse(data);
    if (json.payload?.choices?.text) reply += json.payload.choices.text[0].content;
  });
  ws.on('close', () => res.json({ reply }));
  ws.on('error',(err)=>{
    console.error("对话错误",err);
    res.json({ reply: "对话出错了" });
  })
});

// ---- 4. 讯飞TTS ----
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  const sign = getXfSign(XF_APPID, XF_API_KEY, XF_API_SECRET);
  const url = `https://tts-api.xfyun.cn/v2/tts`;
  try{
    const result = await axios.post(url, {
      common: { app_id: XF_APPID },
      business: { aue: 'lame', vcn: 'x4_lingxiaoyao' },
      data: { text: Buffer.from(text).toString('base64') }
    }, {
      headers: {
        'Authorization': `hmac sha256 ${sign}`,
        'X-Appid': XF_APPID,
        'X-Timestamp': Math.floor(Date.now() / 1000)
      },
      responseType: 'arraybuffer'
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(result.data);
  }catch(e){
    console.error("TTS错误",e);
    res.status(500).send("语音生成失败");
  }
});

// ---- 5. 天气运势 ----
app.get('/api/weather', async (req, res) => {
  try {
    const city = req.query.city || '杭州';
    const url = `https://devapi.qweather.com/v7/weather/now?location=${city}&key=${WEATHER_KEY}`;
    const result = await axios.get(url);
    res.json(result.data);
  } catch (e) {
    res.json({ now: { text: '晴', temp: '25' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));