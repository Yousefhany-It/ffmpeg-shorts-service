const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), 'uploads') });
app.use(express.json({ limit: '20mb' }));

const WORK_DIR = path.join(os.tmpdir(), 'shorts-work');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function cleanup(paths) {
  paths.forEach((p) => {
    if (p && fs.existsSync(p)) fs.unlink(p, () => {});
  });
}

// Health check - hit this after deploying to confirm the service is alive
app.get('/health', (req, res) => res.json({ ok: true }));

// 1. Download a video from a URL (YouTube, etc.) using yt-dlp
// body: { "url": "https://..." }
app.post('/download', async (req, res) => {
  const id = uuidv4();
  const outPath = path.join(WORK_DIR, `${id}.mp4`);
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    await run('yt-dlp', ['-f', 'mp4', '-o', outPath, url]);
    res.download(outPath, () => cleanup([outPath]));
  } catch (err) {
    cleanup([outPath]);
    res.status(500).json({ error: err.message });
  }
});

// 2. Extract audio only (keeps the Whisper upload small and fast)
// multipart form field: video
app.post('/extract-audio', upload.single('video'), async (req, res) => {
  const id = uuidv4();
  const outPath = path.join(WORK_DIR, `${id}.mp3`);
  try {
    await run('ffmpeg', ['-i', req.file.path, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', outPath]);
    res.download(outPath, () => cleanup([outPath, req.file.path]));
  } catch (err) {
    cleanup([outPath, req.file?.path]);
    res.status(500).json({ error: err.message });
  }
});

// 3. Cut a clip, crop/scale to 9:16 vertical, and burn in captions
// multipart form fields: video (file), start (seconds), end (seconds),
// captions (JSON string: [{ "start": 0, "end": 2.5, "text": "..." }, ...] - times relative to the CLIP, not the source)
app.post('/process', upload.single('video'), async (req, res) => {
  const id = uuidv4();
  const trimmed = path.join(WORK_DIR, `${id}-trim.mp4`);
  const srtPath = path.join(WORK_DIR, `${id}.srt`);
  const finalPath = path.join(WORK_DIR, `${id}-final.mp4`);
  try {
    const { start, end } = req.body;
    const captions = JSON.parse(req.body.captions || '[]');

    // Trim to the chosen segment using stream copy (no re-encoding) — this is
    // dramatically lighter on CPU/memory than transcoding, which matters on
    // memory-limited free-tier hosts.
    await run('ffmpeg', [
      '-ss', String(start),
      '-to', String(end),
      '-i', req.file.path,
      '-c', 'copy',
      trimmed,
    ]);

    // Build an .srt caption file if captions were provided
    if (captions.length) {
      const fmt = (t) => {
        const h = String(Math.floor(t / 3600)).padStart(2, '0');
        const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
        const s = String(Math.floor(t % 60)).padStart(2, '0');
        const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
        return `${h}:${m}:${s},${ms}`;
      };
      const srt = captions
        .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`)
        .join('\n');
      fs.writeFileSync(srtPath, srt);
    }

    // Crop/scale to 1080x1920 and burn in subtitles if present.
    // Crop FIRST (cheap) to a 9:16 region, then scale DOWN to the final size —
    // scaling up before cropping (the old approach) is much slower and can time out
    // on landscape source videos.
    const cropFilter = `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'`;
    const vf = captions.length
      ? `${cropFilter},scale=1080:1920,subtitles=${srtPath}:force_style='Fontsize=20,PrimaryColour=&HFFFFFF&,Outline=2'`
      : `${cropFilter},scale=1080:1920`;

    await run('ffmpeg', ['-i', trimmed, '-vf', vf, '-preset', 'veryfast', '-c:a', 'copy', finalPath]);

    res.download(finalPath, () => cleanup([req.file.path, trimmed, srtPath, finalPath]));
  } catch (err) {
    cleanup([req.file?.path, trimmed, srtPath, finalPath]);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ffmpeg-shorts-service listening on port ${PORT}`));
