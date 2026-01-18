# Browser Stream Bridge

一个 **将视频网站中 `<video>` 元素的数据实时转发为 HLS 流** 的 Node.js 服务，基于 **Playwright + MediaRecorder + FFmpeg + 内置 HTTP Server**。

适合场景：

* 🎬 各类视频网站（HTML5 `<video>` 播放器）
* 📡 仅提供浏览器播放、**无法直接拉流** 的站点
* 🔁 将网页视频桥接到 **HLS / Web 播放器 / 传统流媒体系统**
* 🧪 WebRTC / MSE / blob URL 视频转发

---

## ✨ 特性

* 🎯 **只处理 `<video>` 元素**：不做桌面录制、不截图，直接转发播放器视频流

* 🚀 **HTTP API 即开即用**：传入网页 URL，立即返回 HLS 播放地址

* ♻️ **流复用**：同一 URL 自动复用已有流

* 🧹 **无人观看自动回收**（基于 HLS 访问时间）

* 🎥 **H.264 直通**：Playwright → MediaRecorder → FFmpeg `-c:v copy`

* 🔇 **可选音频**：Opus → AAC

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
FFmpeg (copy video, transcode audio)
   │
   │ HLS muxer
   ▼
.m3u8 + .ts segments
   │
   ▼
HTTP Server → Clients (Browser / VLC / FFmpeg)
```

---

## 📦 依赖

* Node.js >= 18
* Playwright (Chromium)
* FFmpeg (需支持 H.264 / AAC)

---

## 📁 目录结构

```
.
├─ src/
│  └─ index.ts             # 主服务
|  └─ logger.ts            # 日志模块
├─ assets/
│  ├─ page_preload.js      # 注入到页面的媒体采集逻辑
│  └─ page_block_list.txt  # 页面资源拦截规则
└─ README.md
```

---

## 🔧 环境变量配置

Browser Stream Bridge 支持通过环境变量进行运行时配置，便于在不同环境（本地 / Docker / 服务器）部署。

| 变量名          | 默认值      | 说明                            |
| --------------- | ----------- | ------------------------------- |
| `SERVER_IP`     | `127.0.0.1` | HLS 中返回的访问 IP             |
| `SERVER_PORT`   | `3001`      | HTTP 服务端口                   |
| `HLS_DIR`       | `./hls`     | HLS 文件输出目录                |
| `VIDEO_BITRATE` | `6000000`   | MediaRecorder 视频码率（bit/s） |

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
GET /api/stream?url=<page_url>
```

示例：

```
http://127.0.0.1:3001/api/stream?url=https://example.com/live
```

返回（HLS Playlist）：

```
http://127.0.0.1:3001/hls/stream_12345678/live.m3u8
```

---

## 📺 播放

### 浏览器 / HLS.js

```html
<video src="http://127.0.0.1:3001/hls/stream_xxx/live.m3u8" controls autoplay></video>
```

### VLC

```bash
vlc http://127.0.0.1:3001/hls/stream_xxx/live.m3u8
```

### FFmpeg

```bash
ffmpeg -i http://127.0.0.1:3001/hls/stream_xxx/live.m3u8 -c copy out.mp4
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

recorder.start(1000);
```

---

## 🧹 自动回收策略

服务内置定时清理任务（10 秒一次）：

- 记录每个 Stream 的 `lastVisit`
- 当 **10 秒内无 HLS 访问** 时自动回收：
  - `ffmpeg.kill('SIGINT')`
  - `page.close()`

确保不会产生僵尸浏览器或残留 FFmpeg 进程。

---

## ⚠️ 注意事项

- `/api/stream` 本身不返回 JSON，而是直接返回 `live.m3u8` 内容
- HLS 切片参数：
  - `hls_time = 1s`
  - `hls_list_size = 5`
- FFmpeg 使用 `-c:v copy`，要求页面输出 H.264
- Headless Chrome 可能触发部分站点降清晰度策略
- 页面必须使用 **H.264 可播放**（Chrome 支持）
- DRM（Widevine）页面 **无法捕获**
- HLS 延迟通常为 **2–6 秒**
- 高分辨率 / 高码率会显著增加 CPU 占用

---

## ❌ 局限性 / 缺点（Limitations）

- 启动速度慢于原生 HLS
- 端到端延迟高于 WebRTC / RTSP
- 浏览器资源占用高
- 不适合大规模并发
- 依赖目标网站稳定性
- DRM 内容无法支持

---

## 📜 License

MIT
