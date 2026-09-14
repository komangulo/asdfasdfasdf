/**
 * On-screen text detection + Spanish translation + ASS overlay generation.
 *
 * The pipeline samples frames from a video, asks a vision model (Gemini) to
 * read the on-screen text and its position/size, translates each phrase to
 * Spanish, then writes an ASS subtitle file that renders the translation at
 * the same place on screen with a similar size. The ASS file is burned into
 * the video with ffmpeg's `subtitles` filter by the AutoClone controller.
 */

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_VISION_MODEL = "gemini-2.5-flash";
const DEFAULT_SAMPLE_SECONDS = 0.6; // one frame every 0.6s
const MAX_BATCH_FRAMES = 12; // frames per vision request
const MAX_FRAMES = 240; // hard cap for very long videos

function run(cmd, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        const error = new Error(`Command timed out after ${timeout}ms: ${cmd}`);
        error.stderr = stderr;
        finish(reject, error);
      }, timeout);
      timer.unref?.();
    }

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      error.stderr = stderr;
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with code ${code}: ${cmd}`);
      error.code = code;
      error.stderr = stderr;
      finish(reject, error);
    });
  });
}

function resolveFfmpeg() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function resolveFfprobe() {
  return process.env.FFPROBE_PATH || "ffprobe";
}

async function probeDuration(videoPath) {
  try {
    const { stdout } = await run(resolveFfprobe(), [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function probeSize(videoPath) {
  try {
    const { stdout } = await run(resolveFfprobe(), [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0", videoPath,
    ]);
    const [width, height] = stdout.trim().split("x").map(Number);
    return { width: width || 1080, height: height || 1920 };
  } catch {
    return { width: 1080, height: 1920 };
  }
}

/** Extract one small frame at every `stepSeconds`, capped at MAX_FRAMES. */
async function sampleFrames(videoPath, outputDir, { stepSeconds = DEFAULT_SAMPLE_SECONDS } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const duration = await probeDuration(videoPath);
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration / stepSeconds)));
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const time = Number((index * stepSeconds).toFixed(2));
    const target = path.join(outputDir, `t${String(Math.round(time * 1000)).padStart(7, "0")}.jpg`);
    try {
      await run(resolveFfmpeg(), [
        "-y", "-ss", String(time), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "5", target,
      ]);
      frames.push({ time, path: target });
    } catch {
      // Skip undecodable timestamps.
    }
  }
  return { frames, duration };
}

function parseJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  const startObj = candidate.indexOf("{");
  if (start >= 0 && end > start && (startObj < 0 || start < startObj)) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  if (startObj >= 0) {
    const endObj = candidate.lastIndexOf("}");
    return JSON.parse(candidate.slice(startObj, endObj + 1));
  }
  throw new Error("La IA no devolvió JSON válido para el texto en pantalla.");
}

const VISION_SYSTEM = `Eres un sistema de OCR + traduccion para videos verticales (TikTok).
Recibes una lista de fotogramas, cada uno con su marca de tiempo (segundo) y resolucion.
Debes leer TODO el texto visible en pantalla (subtitulos quemados, rotulos, titulos, stickers, texto del HUD) y, para cada bloque de texto:

1. Copia el texto original EXACTO tal y como se ve.
2. Traducelo al espanol de forma natural y breve (si ya esta en espanol, deja el mismo texto).
3. Estima su posicion y tamano como valores normalizados de 0 a 1:
   - x, y: esquina superior izquierda del bloque de texto respecto al ancho y alto del fotograma.
   - w, h: ancho y alto del bloque de texto respecto al ancho y alto del fotograma.
   - IMPORTANTE: el rectangulo debe cubrir TODO el texto visible, incluidas todas
     las lineas y los bordes de las letras. Redondea hacia afuera (deja un poco de
     margen) para que al taparlo con un recuadro opaco no asome nada del original.
     Si el texto ocupa varias lineas, devuelve un unico bloque que las englobe.
4. Da el segundo de inicio y fin en el que ese texto permanece visible (aproximado a partir de las marcas de tiempo dadas). Si solo aparece en un fotograma, usa ese segundo como inicio y fin + 0.6.

Reglas:
- No inventes texto que no se vea. Si un fotograma no tiene texto, no devuelvas nada para el.
- Ignora marcas de agua delgadas y contadores de la app (bateria, hora del sistema) si son pequenos.
- Agrupa palabras que forman una misma frase en un solo bloque.
- Manten el texto traducido corto: si es muy largo, resume sin perder el sentido.

Devuelve EXCLUSIVAMENTE un array JSON valido, sin markdown:
[
  {
    "start": 0.0,
    "end": 2.4,
    "original": "texto original",
    "translated": "texto traducido al espanol",
    "x": 0.10, "y": 0.72, "w": 0.80, "h": 0.10,
    "confidence": 0.0
  }
]`;

async function callGeminiVision(apiKey, model, frameParts, videoWidth, videoHeight) {
  const body = {
    systemInstruction: { parts: [{ text: VISION_SYSTEM }] },
    contents: [{
      role: "user",
      parts: [
        { text: `Resolucion del video: ${videoWidth}x${videoHeight}. Fotogramas:` },
        ...frameParts,
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json" },
  };
  const response = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `El proveedor respondio ${response.status}`;
    if (/API key/i.test(message)) throw new Error("La API key no es valida.");
    if (response.status === 429) throw new Error("Se agoto la cuota de IA. Intentalo mas tarde.");
    throw new Error(message);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  return text;
}

async function fileToBase64(filePath) {
  return (await fs.readFile(filePath)).toString("base64");
}

/**
 * Detect on-screen text across the whole video and translate it to Spanish.
 * Returns [{ start, end, original, translated, x, y, w, h, confidence }]
 */
async function detectAndTranslate(videoPath, { apiKey, model = DEFAULT_VISION_MODEL, workDir, onProgress } = {}) {
  if (!apiKey) throw new Error("Falta la API key de IA para leer el texto en pantalla.");
  const { width, height } = await probeSize(videoPath);
  const frameDir = path.join(workDir, "frames");
  onProgress?.({ stage: "text-frames", detail: "Extrayendo fotogramas para leer el texto..." });
  const { frames, duration } = await sampleFrames(videoPath, frameDir);
  if (!frames.length) return { boxes: [], errors: ["No se pudieron extraer fotogramas del video."], duration, frames: 0 };

  const models = modelCandidates(model);
  const errors = [];
  const results = [];
  for (let index = 0; index < frames.length; index += MAX_BATCH_FRAMES) {
    const batch = frames.slice(index, index + MAX_BATCH_FRAMES);
    const parts = [];
    for (const frame of batch) {
      parts.push({ text: `Fotograma en el segundo ${frame.time}:` });
      parts.push({ inline_data: { mime_type: "image/jpeg", data: await fileToBase64(frame.path) } });
    }
    onProgress?.({ stage: "text-vision", detail: `Leyendo texto en pantalla (${index + batch.length}/${frames.length})...` });
    let text = null;
    let lastError = null;
    for (const candidate of models) {
      try {
        text = await callGeminiVision(apiKey, candidate, parts, width, height);
        if (candidate !== models[0]) model = candidate;
        break;
      } catch (error) {
        lastError = error;
        // A bad model name or quota is worth trying the next candidate; auth errors are not.
        if (/API key|no es valida|permission|403/i.test(error.message)) break;
      }
    }
    if (text === null) {
      const message = lastError?.message || "error desconocido";
      if (!errors.includes(message)) errors.push(message);
      onProgress?.({ stage: "text-warning", detail: `No se pudo leer un lote de fotogramas: ${message}` });
      continue;
    }
    try {
      const parsed = parseJson(text);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const translated = String(item.translated ?? item.original ?? "").trim();
          if (!translated) continue;
          const start = Number(item.start);
          const end = Number(item.end);
          results.push({
            start: Number.isFinite(start) ? start : batch[0].time,
            end: Number.isFinite(end) && end > start ? end : (Number.isFinite(start) ? start : batch[0].time) + 0.6,
            original: String(item.original || "").slice(0, 500),
            translated: translated.slice(0, 500),
            x: clamp01(item.x, 0.05),
            y: clamp01(item.y, 0.75),
            w: clamp01(item.w, 0.9),
            h: clamp01(item.h, 0.12),
            confidence: Number(item.confidence) || 0.5,
          });
        }
      }
    } catch (error) {
      if (!errors.includes(error.message)) errors.push(error.message);
      onProgress?.({ stage: "text-warning", detail: `Respuesta no valida de la IA: ${error.message}` });
    }
  }

  const boxes = dedupeBoxes(results);
  onProgress?.({ stage: "text-done", detail: `Detectados ${boxes.length} bloques de texto.` });
  return { boxes, errors, duration, frames: frames.length, width, height };
}

/** Build an ordered list of model names to try, so a wrong default still works. */
function modelCandidates(preferred) {
  const list = [preferred, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"].filter(Boolean);
  return [...new Set(list)];
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

/** Merge near-duplicate detections of the same phrase across adjacent frames. */
function dedupeBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => a.start - b.start || a.translated.localeCompare(b.translated));
  const merged = [];
  for (const box of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.original === box.original && box.start <= last.end + 0.35) {
      last.end = Math.max(last.end, box.end);
      last.x = (last.x + box.x) / 2;
      last.y = (last.y + box.y) / 2;
      last.w = (last.w + box.w) / 2;
      last.h = (last.h + box.h) / 2;
    } else {
      merged.push({ ...box });
    }
  }
  return merged;
}

// --------------------------------------------------------------- ASS writer

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function escapeAssText(text) {
  return String(text).replace(/\r?\n/g, "\\N").replace(/[{}]/g, "");
}

/**
 * Build an ASS file that puts each translated phrase at its original position,
 * with an opaque rounded black box behind it so the original text is hidden.
 * Font size is derived from the detected box height relative to the video.
 */
function buildAss(boxes, { width = 1080, height = 1920 } = {}) {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Overlay,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,20,20,20,1",
    "Style: Cover,Arial,48,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = [];
  for (const box of boxes) {
    const rawW = box.w * width;
    const rawH = box.h * height;

    // Tight frame around the detected text: just enough to hide the glyph edges,
    // never a big block that eats the screen.
    const padX = Math.round(width * 0.018);
    const padY = Math.round(height * 0.016);
    let coverW = Math.round(rawW) + padX * 2;
    let coverH = Math.round(rawH) + padY * 2;

    // Hard caps: the cover may not exceed a sensible share of the frame, so it
    // can never blanket the video even if the AI returned a huge box.
    coverW = Math.min(coverW, Math.round(width * 0.92));
    coverH = Math.min(coverH, Math.round(height * 0.32));

    // Center the cover on the detected text.
    const centerX = box.x * width + rawW / 2;
    const centerY = box.y * height + rawH / 2;
    let coverX = Math.max(0, Math.round(centerX - coverW / 2));
    let coverY = Math.max(0, Math.round(centerY - coverH / 2));
    coverX = Math.min(coverX, width - coverW);
    coverY = Math.min(coverY, height - coverH);

    const text = escapeAssText(box.translated);
    // Text must fit inside the tight cover: shrink the font until it does.
    const innerPadX = Math.round(coverW * 0.06);
    const innerPadY = Math.round(coverH * 0.14);
    const availW = Math.max(20, coverW - innerPadX * 2);
    const availH = Math.max(20, coverH - innerPadY * 2);
    let fontSize = Math.max(14, Math.min(140, Math.round(availH * 0.62)));
    let lines = 1;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const charsPerLine = Math.max(6, Math.floor(availW / (fontSize * 0.55)));
      lines = Math.max(1, Math.ceil(text.length / charsPerLine));
      const neededH = lines * fontSize * 1.22;
      if (neededH <= availH) break;
      fontSize = Math.max(14, Math.floor(fontSize * 0.9));
    }

    const start = assTime(box.start);
    const end = assTime(box.end);

    // Rounded opaque black rectangle drawn as an ASS vector shape (\p1 = filled).
    const drawing = roundedRect(0, 0, coverW, coverH, Math.round(Math.min(coverW, coverH) * 0.18));
    events.push(`Dialogue: 0,${start},${end},Cover,,0,0,0,,{\\an7\\pos(${coverX},${coverY})\\p1\\bord0\\shad0\\c&H000000&}${drawing}{\\p0}`);

    // Translated text centered inside the covered area.
    const textCenterX = Math.round(coverX + coverW / 2);
    const textCenterY = Math.round(coverY + coverH / 2);
    const override = `{\\an5\\pos(${textCenterX},${textCenterY})\\fs${fontSize}\\bord2\\shad0}`;
    events.push(`Dialogue: 1,${start},${end},Overlay,,0,0,0,,${override}${text}`);
  }

  return `${header}\n${events.join("\n")}\n`;
}

/** ASS vector path for a rounded rectangle starting at (0,0) in local coords. */
function roundedRect(x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r === 0) {
    return `m ${x} ${y} l ${x + w} ${y} l ${x + w} ${y + h} l ${x} ${y + h}`;
  }
  // ASS uses cubic beziers (b x1 y1 x2 y2 x3 y3). Approximate each quarter arc
  // with the standard circle constant so corners look smooth.
  const k = Math.round(r * 0.5523);
  const x1 = x + w;
  const y1 = y + h;
  return [
    `m ${x + r} ${y}`,
    `l ${x1 - r} ${y}`,
    `b ${x1 - r + k} ${y} ${x1} ${y + r - k} ${x1} ${y + r}`,
    `l ${x1} ${y1 - r}`,
    `b ${x1} ${y1 - r + k} ${x1 - r + k} ${y1} ${x1 - r} ${y1}`,
    `l ${x + r} ${y1}`,
    `b ${x + r - k} ${y1} ${x} ${y1 - r + k} ${x} ${y1 - r}`,
    `l ${x} ${y + r}`,
    `b ${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}`,
  ].join(" ");
}

async function writeAssFor(videoPath, boxes, assPath, size) {
  const ass = buildAss(boxes, size);
  await fs.mkdir(path.dirname(assPath), { recursive: true });
  await fs.writeFile(assPath, ass, "utf8");
  return assPath;
}

module.exports = {
  detectAndTranslate,
  buildAss,
  writeAssFor,
  sampleFrames,
  dedupeBoxes,
  parseJson,
  probeDuration,
  probeSize,
  DEFAULT_VISION_MODEL,
};
