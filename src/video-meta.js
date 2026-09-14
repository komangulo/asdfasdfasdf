/**
 * Video metadata companions.
 *
 * When yt-dlp downloads a TikTok video we ask it for --write-info-json, which
 * leaves a "<video>.info.json" next to the file. This module turns that rich
 * dump into a small, stable companion file "<video>.meta.json" holding just the
 * title, description and hashtags, so the publisher can reuse them.
 *
 * The companion shape is:
 *   { title: string, description: string, hashtags: string[], caption: string }
 */

const fs = require("fs/promises");
const path = require("path");
const { buildCaptionFromMeta, extractHashtags } = require("./queue");

const INFO_JSON_SUFFIX = ".info.json";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);

function infoJsonPathFor(videoPath) {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}${INFO_JSON_SUFFIX}`);
}

function metaJsonPathFor(videoPath) {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}.meta.json`);
}

/** Normalize a yt-dlp "tags" value (array, string or null) into a clean list. */
function normalizeTagList(value) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") list = value.split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const tag = String(entry || "").replace(/^#+/, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Build the companion metadata object from a yt-dlp info.json payload.
 * Prefers explicit fields, falls back to hashtags embedded in the text.
 */
function metaFromInfoJson(info = {}) {
  const title = String(info.title || info.fulltitle || "").trim();
  const description = String(info.description || "").trim();
  const explicitTags = normalizeTagList(info.tags || info.hashtags || []);
  const hashtags = explicitTags.length ? explicitTags : extractHashtags(`${title} ${description}`);
  const caption = buildCaptionFromMeta({ title, description, hashtags });
  return { title, description, hashtags, caption };
}

/**
 * If a "<video>.info.json" exists next to the video, write "<video>.meta.json".
 * Returns the metadata object, or null when there is nothing to do.
 */
async function writeMetaFromInfoJson(videoPath, { logger = null } = {}) {
  const infoPath = infoJsonPathFor(videoPath);
  let info;
  try {
    info = JSON.parse(await fs.readFile(infoPath, "utf8"));
  } catch {
    return null;
  }
  const meta = metaFromInfoJson(info);
  const metaPath = metaJsonPathFor(videoPath);
  try {
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    logger?.(`Wrote metadata: ${path.basename(metaPath)} (title, description, ${meta.hashtags.length} hashtag(s))`);
    return meta;
  } catch (error) {
    logger?.(`Could not write ${path.basename(metaPath)}: ${error.message}`, "error");
    return null;
  }
}

/**
 * Scan a downloads folder for videos newer than `sinceMs` and make sure each
 * has a companion .meta.json. Useful right after a yt-dlp run.
 */
async function enrichRecentVideos(rootDir, sinceMs, { logger = null } = {}) {
  let dirs = [];
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootDir, entry.name));
  } catch {
    return { processed: 0 };
  }

  let processed = 0;
  const walk = async (dir) => {
    let files = [];
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of files) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = await fs.stat(full);
        if (sinceMs && stat.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      // Only write when missing or older than the info.json.
      const metaPath = metaJsonPathFor(full);
      const infoPath = infoJsonPathFor(full);
      try {
        const [metaStat, infoStat] = await Promise.all([fs.stat(metaPath), fs.stat(infoPath)]);
        if (metaStat.mtimeMs >= infoStat.mtimeMs) continue;
      } catch {
        // Missing one of them: try to write anyway.
      }
      const meta = await writeMetaFromInfoJson(full, { logger });
      if (meta) processed += 1;
    }
  };

  await walk(rootDir);
  return { processed };
}

module.exports = {
  INFO_JSON_SUFFIX,
  infoJsonPathFor,
  metaJsonPathFor,
  metaFromInfoJson,
  normalizeTagList,
  writeMetaFromInfoJson,
  enrichRecentVideos,
};
