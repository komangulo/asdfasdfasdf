/**
 * AutoClone controller — one-button pipeline.
 *
 * Given a TikTok username it:
 *   1. Runs a competitor analysis so the user sees what the profile is about.
 *   2. Downloads every video from that profile (yt-dlp).
 *   3. For each video: reads the on-screen text, translates it to Spanish,
 *      overlays the translation in place, and runs the video uniquifier.
 *
 * Progress is streamed over SSE. All state lives under .runtime/autoclone/.
 */

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { config } = require("../config");

const ROOT = path.resolve(config.projectRoot, ".runtime", "autoclone");
const JOBS_DIR = path.join(ROOT, "jobs");
const textOverlay = require("./text-overlay");
const { writeMetaFromInfoJson } = require("../video-meta");
const { ytDlpCommand } = require("../yt-dlp");

function nowIso() { return new Date().toISOString(); }

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || `job-${Date.now()}`;
}

function resolveYtDlp() {
  return ytDlpCommand();
}

function resolveFfmpeg() { return process.env.FFMPEG_PATH || "ffmpeg"; }
function resolveFfprobe() { return process.env.FFPROBE_PATH || "ffprobe"; }

function run(cmd, args, { timeout = 900_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
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
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      }, timeout);
      timer.unref?.();
    }

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      error.stdout = stdout;
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
      error.stdout = stdout;
      error.stderr = stderr;
      finish(reject, error);
    });
  });
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write JSON atomically when possible. On Windows a tmp+rename can fail with
 * EPERM/EBUSY when antivirus, OneDrive or Explorer briefly locks the files
 * (common under C:\Users\...\Downloads), so retry and, as a last resort, write
 * straight to the target file.
 */
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) {
          break;
        }
        await sleep(120 * (attempt + 1));
      }
    }
  } catch (error) {
    if (!["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(error.code)) throw error;
  }
  // Last resort: write directly to the target, retrying a few times.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.writeFile(filePath, body, { encoding: "utf8", mode: 0o600 });
      break;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) throw error;
      await sleep(150 * (attempt + 1));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
}

function normalizeHandle(target) {
  let value = String(target || "").trim();
  if (!value) return "";
  if (value.startsWith("http")) {
    try {
      const parsed = new URL(value);
      const match = parsed.pathname.match(/@([^/]+)/);
      return match ? `@${match[1]}` : value;
    } catch { return value; }
  }
  return value.startsWith("@") ? value : `@${value}`;
}

class AutoCloneController extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.running = false;
    this.cancelRequested = false;
    this.jobId = null;
    this.lastProgress = { stage: "idle", detail: "Sin trabajo en curso.", percent: 0 };
    fsSync.mkdirSync(JOBS_DIR, { recursive: true });
  }

  getProgress() { return this.lastProgress; }

  get lastFolder() {
    return this.lastProgress?.folder || null;
  }

  /** Validate a destination folder and preview the per-user subfolder name. */
  async checkDestination(destinationRoot, username = "") {
    const raw = String(destinationRoot || "").trim();
    if (!raw) return { valid: false, folder: "", perUser: "" };
    const resolved = path.resolve(raw);
    try {
      await fs.mkdir(resolved, { recursive: true });
      await fs.access(resolved, fsSync.constants.W_OK);
      const handle = normalizeHandle(username);
      const clean = handle.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "");
      return {
        valid: true,
        folder: resolved,
        perUser: clean ? path.join(resolved, clean) : resolved,
      };
    } catch {
      return { valid: false, folder: resolved, perUser: "", error: "La carpeta no existe o no se puede escribir en ella." };
    }
  }

  _report(stage, detail, extra = {}) {
    this.lastProgress = { stage, detail, at: nowIso(), ...extra };
    this.emit("progress", this.lastProgress);
  }

  /** Read the Gemini key saved by the Competencia section so both share it. */
  async _aiSettings() {
    const competitorSettings = await readJson(
      path.resolve(config.projectRoot, ".runtime", "competitor", "settings.json"),
      {},
    );
    return {
      apiKey: competitorSettings.geminiApiKey || process.env.GEMINI_API_KEY || "",
      model: competitorSettings.model || "gemini-2.5-flash",
      visionModel: process.env.AUTOCLONE_VISION_MODEL || competitorSettings.model || "gemini-2.5-flash",
    };
  }

  async listJobs() {
    const names = await fs.readdir(JOBS_DIR).catch(() => []);
    const jobs = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const raw = await readJson(path.join(JOBS_DIR, name), null);
      if (raw) jobs.push({
        id: raw.id, handle: raw.handle, status: raw.status, createdAt: raw.createdAt,
        totalVideos: raw.videos?.length || 0,
        processed: (raw.videos || []).filter((v) => v.status === "done").length,
        analysisSummary: raw.analysis?.summary || "",
      });
    }
    jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return jobs;
  }

  async getJob(id) { return readJson(path.join(JOBS_DIR, `${safeId(id)}.json`), null); }

  async _saveJob(job) {
    await writeJson(path.join(JOBS_DIR, `${safeId(job.id)}.json`), job);
  }

  cancel() {
    if (!this.running) return { ok: false, error: "No hay ningun trabajo en curso." };
    this.cancelRequested = true;
    this._report("cancelling", "Cancelando...", { percent: this.lastProgress.percent });
    return { ok: true };
  }

  /**
   * Kick off the pipeline. Returns immediately; progress arrives over SSE.
   * options: { username, maxVideos, uniquify, translate, minViews, destinationRoot }
   */
  async start(options = {}) {
    if (this.running) throw new Error("Ya hay una ejecucion en curso. Espera a que termine.");
    const handle = normalizeHandle(options.username);
    if (!handle) throw new Error("Escribe un nombre de usuario de TikTok.");

    const destinationRoot = String(options.destinationRoot || "").trim();
    if (destinationRoot) {
      const resolved = path.resolve(destinationRoot);
      try {
        await fs.mkdir(resolved, { recursive: true });
        await fs.access(resolved, fsSync.constants.W_OK);
      } catch {
        throw new Error(`No se puede escribir en la carpeta de destino: ${destinationRoot}`);
      }
    }

    const job = {
      id: `${safeId(handle)}-${Date.now()}`,
      handle,
      url: `https://www.tiktok.com/${handle}`,
      createdAt: nowIso(),
      status: "running",
      options: {
        maxVideos: Number(options.maxVideos) || 0,
        uniquify: options.uniquify !== false,
        translate: options.translate !== false,
        minViews: Number(options.minViews) || 0,
        uniquifyIntensity: options.uniquifyIntensity || "media",
        uniquifyOptions: options.uniquifyOptions && typeof options.uniquifyOptions === "object"
          ? options.uniquifyOptions
          : {},
        destinationRoot: destinationRoot ? path.resolve(destinationRoot) : "",
      },
      analysis: null,
      videos: [],
    };
    await fs.mkdir(this._videoDir(job), { recursive: true });
    await this._saveJob(job);

    this.running = true;
    this.cancelRequested = false;
    this.jobId = job.id;

    this._run(job).catch((error) => {
      this._report("error", error.message, { percent: 100 });
    }).finally(() => {
      this.running = false;
    });

    return { id: job.id, handle, folder: this._userDir(job) };
  }

  _videoDir(job) { return path.join(ROOT, "jobs", safeId(job.id)); }
  /** Folder the finished videos land in: chosen destination/<user> or the job folder. */
  _userDir(job) {
    const username = String(job.handle || "").replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "") || "usuario";
    if (job.options?.destinationRoot) return path.join(job.options.destinationRoot, username);
    return path.join(this._videoDir(job), "outputs");
  }
  _downloadDir(job) { return path.join(this._videoDir(job), "downloads"); }
  _outputDir(job) { return this._userDir(job); }
  _workDir(job) { return path.join(this._videoDir(job), "work"); }

  async _run(job) {
    const ai = await this._aiSettings();
    try {
      // 1) Competitor analysis -------------------------------------------
      this._report("analysis", `Analizando el perfil ${job.handle}...`, { percent: 3 });
      try {
        const competitor = require("../competitor/controller").getCompetitorController();
        const report = await competitor.analyze({ target: job.handle, depth: 24, language: "es" });
        job.analysis = {
          id: report.id || "",
          summary: report.summary || "",
          metrics: report.metrics || {},
          style: report.style || {},
          narrative: report.narrative || {},
          categories: report.categories || {},
          opportunities: report.opportunities || [],
          masterPrompt: report.masterPrompt || "",
          dataQuality: report.dataQuality,
        };
        await this._saveJob(job);
        this._report("analysis", "Analisis completado.", { percent: 12 });
      } catch (error) {
        job.analysis = { error: error.message };
        await this._saveJob(job);
        this._report("analysis-warning", `El analisis fallo (${error.message}). Se continua con la descarga.`, { percent: 12 });
      }

      // 2) Download every video ------------------------------------------
      this._report("download", "Descargando los videos del perfil...", { percent: 15 });
      const downloaded = await this._downloadAll(job, ai);
      if (this.cancelRequested) throw new Error("Ejecucion cancelada.");
      if (!downloaded.length) throw new Error("No se pudo descargar ningun video del perfil.");
      this._report("download", `${downloaded.length} videos descargados.`, { percent: 45 });

      // 3) Per video: translate overlay + uniquify -----------------------
      await fs.mkdir(this._outputDir(job), { recursive: true });
      for (let index = 0; index < downloaded.length; index += 1) {
        if (this.cancelRequested) throw new Error("Ejecucion cancelada.");
        const video = downloaded[index];
        const basePercent = 45 + Math.round((index / downloaded.length) * 53);
        try {
          video.status = "processing";
          await this._saveJob(job);
          const result = await this._processVideo(job, video, ai, {
            onProgress: (progress) => this._report(progress.stage, progress.detail, {
              percent: Math.min(98, basePercent + 2),
              videoIndex: index + 1,
              videoTotal: downloaded.length,
            }),
          });
          Object.assign(video, result, { status: "done" });
        } catch (error) {
          video.status = "error";
          video.error = error.message;
          this._report("video-error", `Video ${index + 1} fallo: ${error.message}`, { percent: basePercent + 2 });
        }
        await this._saveJob(job);
      }

      job.status = this.cancelRequested ? "cancelled" : "done";
      job.finishedAt = nowIso();
      job.folder = this._userDir(job);
      await this._saveJob(job);
      this._report("done", `Pipeline completado: ${job.videos.filter((v) => v.status === "done").length} de ${job.videos.length} videos. Guardados en ${job.folder}`, {
        percent: 100, jobId: job.id, folder: job.folder,
      });
    } catch (error) {
      job.status = this.cancelRequested ? "cancelled" : "error";
      job.error = error.message;
      job.finishedAt = nowIso();
      await this._saveJob(job).catch(() => {});
      this._report("error", error.message, { percent: 100, jobId: job.id });
    }
  }

  /** List profile video URLs then download each one. */
  async _downloadAll(job, ai) {
    const ytDlp = resolveYtDlp();
    if (path.isAbsolute(ytDlp) && !fsSync.existsSync(ytDlp)) {
      throw new Error(
        `No se encontro yt-dlp. Coloca yt-dlp.exe en ${path.dirname(ytDlp)} o define YTDLP_PATH en .env.`
      );
    }
    const downloadDir = this._downloadDir(job);
    await fs.mkdir(downloadDir, { recursive: true });
    const max = job.options.maxVideos;

    const listArgs = ["--no-warnings", "--flat-playlist", "--print", "%(id)s"];
    if (max > 0) listArgs.push("--playlist-items", `1:${max}`);
    listArgs.push(job.url);

    let ids = [];
    try {
      const { stdout } = await run(ytDlp, listArgs, { timeout: 300_000 });
      ids = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      throw new Error(`No se pudo listar el perfil con yt-dlp: ${error.message}`);
    }
    if (!ids.length) throw new Error("El perfil no devolvio videos (puede ser privado o no existir).");

    const videos = [];
    for (let index = 0; index < ids.length; index += 1) {
      if (this.cancelRequested) break;
      const id = ids[index];
      const target = path.join(downloadDir, `${id}.mp4`);
      this._report("download", `Descargando video ${index + 1}/${ids.length}...`, { percent: 15 });
      try {
        await run(ytDlp, [
          "--no-warnings", "-f", "mp4/bestvideo*+bestaudio/best",
          "--merge-output-format", "mp4", "-o", target,
          "--write-info-json",
          `https://www.tiktok.com/${job.handle}/video/${id}`,
        ], { timeout: 600_000 });
        const stat = await fs.stat(target).catch(() => null);
        if (!stat || stat.size < 1024) throw new Error("descarga vacia");
        // Save the video's own title/description/hashtags next to the file.
        try {
          await writeMetaFromInfoJson(target, { logger: (m) => this._report("download", m, {}) });
        } catch (metaError) {
          this._report("download-warning", `Sin metadatos para ${id}: ${metaError.message}`, {});
        }
        videos.push({ id, sourcePath: target, sizeBytes: stat.size, status: "pending" });
      } catch (error) {
        this._report("download-warning", `No se pudo descargar el video ${id}: ${error.message}`, {});
      }
    }
    job.videos = videos;
    await this._saveJob(job);
    return videos;
  }

  /** Translate on-screen text, burn it, then uniquify the result. */
  async _processVideo(job, video, ai, { onProgress } = {}) {
    const workDir = path.join(this._workDir(job), video.id);
    await fs.mkdir(workDir, { recursive: true });
    let current = video.sourcePath;
    video.notes = [];

    const { uniquifyVideo, resolveUniquifyOptions } = require("../video-uniquifier");
    const strengthOptions = resolveUniquifyOptions({
      ...(job.options.uniquifyOptions || {}),
      intensity: job.options.uniquifyIntensity || "media",
      removeAudio: false,
    });

    // Mirror FIRST, on the original frame, so the translated text burned later
    // stays readable. The uniquifier then runs without mirroring again.
    if (job.options.uniquify && strengthOptions.mirror) {
      onProgress?.({ stage: "uniquify", detail: `Volteando el video ${video.id}...` });
      const mirroredPath = path.join(workDir, "mirrored.mp4");
      await this._mirrorVideo(current, mirroredPath);
      current = mirroredPath;
      strengthOptions.mirror = false;
      video.mirrored = true;
    }

    if (job.options.translate) {
      if (!ai.apiKey) {
        video.notes.push("Sin API key de Gemini: no se pudo traducir el texto en pantalla.");
        this._report("translate-warning", "Sin API key de Gemini; se omite la traduccion del texto en pantalla.", {});
      } else {
        onProgress?.({ stage: "translate", detail: `Leyendo y traduciendo el texto del video ${video.id}...` });
        const result = await textOverlay.detectAndTranslate(current, {
          apiKey: ai.apiKey,
          model: ai.visionModel,
          workDir,
          onProgress,
        });
        video.textBoxes = result.boxes.length;
        video.visionErrors = result.errors || [];
        if (result.boxes.length) {
          const assPath = path.join(workDir, "overlay.es.ass");
          await textOverlay.writeAssFor(current, result.boxes, assPath, { width: result.width, height: result.height });
          const translatedPath = path.join(workDir, "translated.mp4");
          await this._burnSubtitles(current, translatedPath, assPath, { width: result.width, height: result.height });
          current = translatedPath;
          video.translated = true;
        } else {
          video.translated = false;
          const detail = video.visionErrors.length
            ? `No se detecto texto traducible (${video.visionErrors[0]})`
            : "No se detecto texto traducible en el video.";
          video.notes.push(detail);
        }
      }
    }

    const outputPath = path.join(this._outputDir(job), `${video.id}${job.options.uniquify ? "_unique" : ""}.mp4`);
    if (job.options.uniquify) {
      onProgress?.({ stage: "uniquify", detail: `Uniquificando el video ${video.id} (${job.options.uniquifyIntensity || "media"})...` });
      await uniquifyVideo(current, outputPath, strengthOptions);
    } else {
      await fs.copyFile(current, outputPath);
    }

    const stat = await fs.stat(outputPath).catch(() => null);
    if (!stat || stat.size < 1024) {
      throw new Error("El procesado termino pero no se genero el video de salida.");
    }
    // Carry the original title/description/hashtags next to the final video so
    // Auto Post can publish with them.
    await this._copyMetaSidecar(video.sourcePath, outputPath);
    return { outputPath, outputSizeBytes: stat.size };
  }

  /**
   * Ensure the finished video has a companion "<name>.meta.json" so Auto Post
   * can always publish with the original title, description and hashtags. It is
   * created even when the video has no translatable text.
   */
  async _copyMetaSidecar(sourceVideoPath, targetVideoPath) {
    const { getMetaPath } = require("../queue");
    const { writeMetaFromInfoJson, metaJsonPathFor, metaFromInfoJson, INFO_JSON_SUFFIX } = require("../video-meta");
    const targetMeta = getMetaPath(targetVideoPath);

    try {
      // 1) Preferred: the metadata file already built next to the download.
      await fs.copyFile(getMetaPath(sourceVideoPath), targetMeta);
      return;
    } catch {
      // No companion yet: try to build it from yt-dlp's info.json.
    }

    try {
      const meta = await writeMetaFromInfoJson(sourceVideoPath);
      if (meta) {
        await fs.copyFile(metaJsonPathFor(sourceVideoPath), targetMeta);
        return;
      }
    } catch {
      // Fall through to the minimal file below.
    }

    // 2) Last resort: still create the file, even if it is empty, so every
    // final video is guaranteed to carry a metadata companion.
    try {
      const { readVideoMeta } = require("../queue");
      const meta = await readVideoMeta(sourceVideoPath);
      const payload = meta || { title: "", description: "", hashtags: [], caption: "" };
      await fs.writeFile(targetMeta, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Non-fatal: the video still publishes, just without its own metadata.
    }
  }

  /** Burn an ASS subtitle file into the video (optional logo overlay preserved). */
  _burnSubtitles(inputPath, outputPath, assPath, { width, height } = {}) {
    const escaped = String(assPath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    return run(resolveFfmpeg(), [
      "-y", "-i", inputPath,
      "-vf", `subtitles='${escaped}':original_size=${width || 1080}x${height || 1920}`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "copy", "-movflags", "+faststart", outputPath,
    ], { timeout: 900_000 });
  }

  /**
   * Mirror the frame horizontally. Applied to the ORIGINAL video before any
   * translated text is burned in, so the on-screen text stays readable.
   */
  _mirrorVideo(inputPath, outputPath) {
    return run(resolveFfmpeg(), [
      "-y", "-i", inputPath,
      "-vf", "hflip",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "copy", "-movflags", "+faststart", outputPath,
    ], { timeout: 900_000 });
  }
}

let instance = null;
function getAutoCloneController() {
  if (!instance) instance = new AutoCloneController();
  return instance;
}

module.exports = { AutoCloneController, getAutoCloneController, ROOT, normalizeHandle, writeJson };
