# Browser Stream Bridge

一个 **将视频网站中 `<video>` 元素的数据实时转发为 HLS（TS）或 Fragmented MP4 流** 的 Node.js 服务，基于 **Playwright + MediaRecorder + FFmpeg + 内置 HTTP Server**。

## 🎯 适合场景

* 🎬 各类视频网站（HTML5 `<video>` 播放器）
* 📡 仅提供浏览器播放、**无法直接拉流** 的站点
* 🔁 将网页视频桥接到 **HLS / Web 播放器 / 传统流媒体系统**
* 🧪 WebRTC / MSE / blob URL 视频转发

---

## ✨ 特性

* 🎯 **只处理 `<video>` 元素**：不做桌面录制、不截图，直接转发播放器视频流

* 🚀 **HTTP API 即开即用**：传入网页 URL，立即返回 HLS 或 FMP4 播放地址

* ♻️ **HLS 流复用**：同一 URL 自动复用已有流

* 🧹 **无人观看自动回收**（基于 HLS 访问时间）

* 🧠 **页面资源拦截**：支持 block list，减少广告 / 追踪

* 🕶 **Headless Chrome**，服务端运行

---

## 🧩 架构

```
Browser(Page)
   │
   │ video.captureStream()
   ▼
MediaRecorder (webm: h264 + opus)
   │
   │ Uint8Array chunks
   ▼
Node.js (__pushMediaChunk)
   │
   │ stdin
   ▼
FFmpeg
   │
   ├─ HLS (TS)
   │     └─ .m3u8 + .ts
   │
   └─ Fragmented MP4
         └─ HTTP chunked (video/mp4)
   │
   ▼
HTTP Server → Clients (Browser / VLC / FFmpeg)
```

---

## 📦 依赖

* Node.js >= 18
* Playwright (Chromium)
* FFmpeg (需支持 H.264 / AAC / MP4 / HLS)

---

## 📁 目录结构

```
.
├─ src/
│  ├─ index.ts          # 主服务入口
│  ├─ browser.ts        # Playwright 管理
│  ├─ hls.ts            # HLS (TS) 输出
│  ├─ fmp4.ts           # Fragmented MP4 输出
│  └─ logger.ts         # 日志模块
├─ assets/
│  ├─ page_preload.js   # 页面注入脚本
│  └─ page_block_list.txt
└─ README.md
```

---

## 🔧 环境变量配置

Browser Stream Bridge 支持通过环境变量进行运行时配置，便于在不同环境（本地 / Docker / 服务器）部署。

| 变量名          | 默认值      | 说明                   |
| --------------- | ----------- | ---------------------- |
| `SERVER_SCHEME` | `http`      | 返回播放地址协议       |
| `SERVER_IP`     | `127.0.0.1` | 对外访问 IP            |
| `SERVER_PORT`   | `3001`      | HTTP 服务端口          |
| `HLS_DIR`       | `./hls`     | HLS 输出目录           |
| `VIDEO_BITRATE` | `4000000`   | MediaRecorder 目标码率 |
| `BUFFER_SEC`    | `0.2`       | fMP4 缓冲秒数          |
| `FFMPEG_PATH`   | `ffmpeg`    | FFmpeg 路径            |

---

## 🚀 启动

### 1️⃣ 安装依赖

```bash
npm install
npx playwright install chromium
```

确保本机已有：

```bash
ffmpeg -version
```

---

### 2️⃣ 启动服务

```bash
npm run build
node dist/index.mjs
```

或使用环境变量：

```bash
SERVER_IP=192.168.1.10 SERVER_PORT=3001 node dist/index.mjs
```

---

### 创建 / 复用流

```
GET /api/stream?url=<page_url>&type=<hls|fmp4>
```

### 示例

#### HLS（TS）

```text
http://127.0.0.1:3001/api/stream?url=https://example.com/live&type=hls
```

返回：

```text
http://127.0.0.1:3001/hls/stream_xxx/live.m3u8
```

------

#### Fragmented MP4（实时）

```text
http://127.0.0.1:3001/api/stream?url=https://example.com/live&type=fmp4
```

返回：

```http
HTTP/1.1 200 OK
Content-Type: video/mp4
Transfer-Encoding: chunked
```

> ⚠️ `type=fmp4` **不是 HLS，没有 m3u8**

---

## 📺 播放

### 浏览器（HLS / fMP4）

```html
<video src="http://127.0.0.1:3001/api/stream?url=...&type=fmp4"
       autoplay
       controls></video>
```

### VLC

```bash
vlc "http://127.0.0.1:3001/api/stream?url=...&type=fmp4"
```

### FFmpeg

```bash
ffmpeg -i "http://127.0.0.1:3001/api/stream?url=...&type=fmp4" -c copy out.mp4
```

---

## 🧠 页面预加载逻辑（核心）

`assets/page_preload.js` 核心思路：

* 找到页面 `<video>`
* 使用 `video.captureStream()`
* `MediaRecorder` 录制为 `video/webm; codecs=h264,opus`
* 通过 `window.__pushMediaChunk()` 把数据推回 Node.js

关键代码：

```js
var stream = video.captureStream();

var recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm;codecs=h264,opus',
  videoBitsPerSecond: 4000000,
  audioBitsPerSecond: 128000
});

recorder.ondataavailable = function (e) {
  if (!e.data || e.data.size === 0) return;
  window.__media_capture_ready = true;
  e.data.arrayBuffer().then(buf => {
    window.__pushMediaChunk(new Uint8Array(buf));
  });
};

recorder.start(100);
```

---

## 🧹 自动回收策略

- HLS：
  - 记录 playlist 访问时间
  - 超时自动销毁 FFmpeg + Page
- fMP4：
  - 客户端断开即销毁
  - 不做流复用

防止：

- 僵尸浏览器
- 残留 FFmpeg 进程

---

## ⚠️ 注意事项

- DRM（Widevine）页面无法捕获
- Headless Chromium 可能触发清晰度限制
- 高分辨率 / 高码率 CPU 占用明显
- fMP4 为 **单播模式**, 延迟通常 **3–5 秒**
- HLS 延迟通常 **5–10 秒**

---

## ❌ 局限性 / 缺点（Limitations）

- 启动慢于原生流
- 延迟高于 WebRTC
- 浏览器资源占用高
- 不适合大规模并发
- 强依赖目标站点稳定性
- DRM 内容不支持

---

## 📜 License

MIT
