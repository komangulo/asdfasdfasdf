/**
 * Competitor AI analyst.
 *
 * Uses Google AI Studio (Gemini) because it is the one provider that accepts
 * both text and images in the same call, with a usable free tier.
 *
 * Input: the raw collector summary + optional frames of the top videos.
 * Output: a structured "Perfil de Competencia" (JSON) plus a "Prompt Maestro".
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3.6-flash";

const SYSTEM_PROMPT = `Eres un analista senior de contenido vertical (TikTok) y estratega de crecimiento.
Recibes datos REALES de un perfil competidor (métricas de vídeos, descripciones, música y, cuando existan, fotogramas).
Tu trabajo es producir un informe accionable y sin relleno. Si un dato no está en la evidencia, dilo como "no observado" en vez de inventarlo.
Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin markdown, sin texto antes ni después.

Esquema exacto:
{
  "summary": "resumen ejecutivo de 2-3 frases",
  "metrics": {
    "followers": number,
    "avgLikes": number,
    "avgComments": number,
    "avgViews": number,
    "engagementRate": number,
    "postingCadencePerWeek": number|null,
    "estimatedMonthlyEarningsUsd": { "low": number, "high": number },
    "notes": "cómo se calcularon y qué limitaciones tienen"
  },
  "style": {
    "avgDurationSeconds": number,
    "onScreenText": "uso de texto en pantalla",
    "transitions": "transiciones observadas",
    "musicAndSfx": "música/efectos recurrentes",
    "paletteAndLighting": "paleta de colores e iluminación",
    "framing": "tipos de plano y encuadre"
  },
  "narrative": {
    "hooksFirst3s": "cómo abren los primeros 3 segundos, con ejemplos",
    "structure": "estructura típica del vídeo",
    "ctas": "llamados a la acción usados",
    "retention": "técnicas de retención detectadas"
  },
  "categories": {
    "mainTopics": ["temas principales"],
    "viralPatterns": "qué tipo de vídeos le dan más viralidad y por qué",
    "bestPerformingExamples": ["ids o títulos de los vídeos top"]
  },
  "opportunities": ["huecos o ángulos que el competidor no explota"],
  "masterPrompt": "plantilla de prompt larga y reutilizable, lista para pegar en un generador de vídeo/imagen por IA, que replique su estilo pero adaptada a nuestra marca. Incluye estructura de guion, tipo de plano, iluminación, ritmo, hook y CTA."
}`;

function buildUserPrompt(report, { brand = "", language = "es", topFrames = [] } = {}) {
  const payload = {
    competidor: report.handle,
    url: report.url,
    resumen_matematico: report.summary,
    videos: report.videos.map((video) => ({
      id: video.id,
      titulo: video.title,
      duracion_s: video.durationSeconds,
      views: video.views,
      likes: video.likes,
      comentarios: video.comments,
      shares: video.shares,
      engagement_pct: video.engagementRate,
      fecha: video.uploadDate,
      musica: [video.artist, video.track].filter(Boolean).join(" - "),
      hashtags: video.hashtags,
    })),
    fotogramas_analizados: topFrames.map((frame) => ({ videoId: frame.videoId, nota: frame.note || "" })),
  };
  return [
    brand ? `Marca del cliente: ${brand}.` : "No se ha especificado la marca del cliente.",
    `Idioma del informe: ${language}.`,
    "Analiza este competidor y produce el JSON del esquema.",
    "Datos reales:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function parseJsonResponse(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("La IA no devolvió JSON válido.");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function listModels(apiKey) {
  const response = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(apiKey)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini respondió ${response.status}`);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

async function callGemini(apiKey, model, parts, { temperature = 0.4, maxOutputTokens = 8192 } = {}) {
  const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature, maxOutputTokens, responseMimeType: "application/json" },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || `Gemini respondió ${response.status}`;
    if (/API key/i.test(message)) throw new Error("La API key de Gemini no es válida.");
    if (response.status === 429) throw new Error("Se agotó la cuota de Gemini. Inténtalo más tarde.");
    if (response.status === 404 || /no longer available|not found|is not supported/i.test(message)) {
      let hint = "";
      try {
        const models = await listModels(apiKey);
        const preferred = models.find((m) => /flash/i.test(m) && !/vision|embedding|image|tts/i.test(m)) || models[0];
        if (preferred) hint = ` Prueba con otro modelo disponible, por ejemplo "${preferred}".`;
      } catch { /* listing is best-effort */ }
      throw new Error(`El modelo "${model}" no está disponible.${hint}`);
    }
    throw new Error(message);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  return { text, usage: data.usageMetadata || null };
}

/**
 * Analyze a collected competitor profile.
 * @param {object} report  Output of tiktok-collector.collect()
 * @param {object} options { apiKey, model, brand, language, frames }
 *   frames: [{ videoId, imageBase64, mimeType }]
 */
async function analyze(report, { apiKey, model = DEFAULT_MODEL, brand = "", language = "es", frames = [] } = {}) {
  if (!apiKey) throw new Error("Falta la API key de Gemini. Añádela en la sección Competencia.");
  const parts = [{ text: buildUserPrompt(report, { brand, language }).replace(/\nDatos reales:/, "\nFotogramas adjuntos de los vídeos más vistos: " + frames.length + "\nDatos reales:") }];

  // Attach up to 12 frames (4 per top video) as inline images.
  for (const frame of frames.slice(0, 12)) {
    parts.push({ text: `Fotograma del vídeo ${frame.videoId}:` });
    parts.push({ inline_data: { mime_type: frame.mimeType || "image/jpeg", data: frame.imageBase64 } });
  }

  const { text, usage } = await callGemini(apiKey, model, parts);
  const analysis = parseJsonResponse(text);
  return { analysis, usage, model };
}

module.exports = { analyze, listModels, SYSTEM_PROMPT, DEFAULT_MODEL };
