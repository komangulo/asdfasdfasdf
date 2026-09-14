const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const overlay = require("../src/autoclone/text-overlay");
const { normalizeHandle, writeJson } = require("../src/autoclone/controller");

test("autoclone normalizeHandle accepts handles and http urls", () => {
  assert.equal(normalizeHandle("usuario"), "@usuario");
  assert.equal(normalizeHandle("@usuario"), "@usuario");
  assert.equal(normalizeHandle("https://www.tiktok.com/@usuario"), "@usuario");
  assert.equal(normalizeHandle("https://www.tiktok.com/@usuario/video/123"), "@usuario");
  assert.equal(normalizeHandle("https://www.tiktok.com/@usuario?lang=es"), "@usuario");
  assert.equal(normalizeHandle("  "), "");
});

test("autoclone writeJson saves the final file and leaves no tmp behind", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-writejson-"));
  try {
    const target = path.join(dir, "job.json");
    await writeJson(target, { hello: "world" });
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { hello: "world" });
    await writeJson(target, { hello: "again" });
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { hello: "again" });
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autoclone buildAss hides the original text with an opaque box then draws the translation", () => {
  const ass = overlay.buildAss([
    { start: 1.2, end: 3.5, translated: "Hola mundo", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
  ], { width: 1080, height: 1920 });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(dialogues.length, 2, "one cover + one translated text");

  const cover = dialogues.find((line) => line.includes("Cover,"));
  const text = dialogues.find((line) => line.includes("Overlay,"));
  assert.ok(cover, "an opaque cover dialogue exists");
  assert.ok(cover.includes("\\p1"), "cover uses an ASS filled vector shape");
  assert.ok(cover.includes("\\c&H000000&"), "cover is black");
  assert.ok(/\bb \d/.test(cover), "cover uses bezier curves for rounded corners");
  assert.ok(cover.includes("0:00:01.20") && cover.includes("0:00:03.50"));
  assert.ok(text.includes("Hola mundo"));
  assert.ok(text.includes("0:00:01.20") && text.includes("0:00:03.50"));
});

test("autoclone buildAss never covers more than a sensible share of the frame", () => {
  // An oversized detected box must still be capped so the video stays visible.
  const ass = overlay.buildAss([
    { start: 0, end: 2, translated: "Texto", x: 0, y: 0, w: 1, h: 1 },
  ], { width: 1000, height: 1000 });
  const cover = ass.split("\n").find((line) => line.includes("Cover,"));
  const coords = [...cover.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  // The drawing path coordinates are all within the style block; the rectangle
  // should not span the full 1000x1000 frame.
  const maxCoord = Math.max(...coords);
  assert.ok(maxCoord <= 950, `cover should stay within caps, got max ${maxCoord}`);
});

test("autoclone dedupeBoxes merges the same phrase across adjacent frames", () => {
  const merged = overlay.dedupeBoxes([
    { start: 0, end: 1, original: "a", translated: "a", x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    { start: 1.1, end: 2, original: "a", translated: "a", x: 0.2, y: 0.2, w: 0.2, h: 0.1 },
    { start: 5, end: 6, original: "b", translated: "b", x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end, 2);
});

test("autoclone parseJson tolerates markdown fences", () => {
  const parsed = overlay.parseJson('```json\n[{"translated":"hola"}]\n```');
  assert.equal(parsed[0].translated, "hola");
});


const { spawnSync } = require("child_process");
const hasFfmpeg = (() => {
  try { return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; }
})();
const visionTest = hasFfmpeg ? test : test.skip;

visionTest("autoclone detectAndTranslate parses translated boxes from the vision model", async () => {
  const os = require("os");
  const path = require("path");
  const originalFetch = global.fetch;
  const payload = [{
    start: 0, end: 1.2,
    original: "Hello world",
    translated: "Hola mundo",
    x: 0.1, y: 0.7, w: 0.8, h: 0.1,
    confidence: 0.9,
  }];
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
  });
  const workDir = require("fs").mkdtempSync(path.join(os.tmpdir(), "ac-vision-"));
  try {
    const result = await overlay.detectAndTranslate(
      path.resolve(__dirname, "fixtures", "tiny.mp4"),
      { apiKey: "test-key", workDir },
    );
    assert.equal(result.boxes.length, 1);
    assert.equal(result.boxes[0].translated, "Hola mundo");
    assert.equal(result.errors.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

visionTest("autoclone detectAndTranslate classifies an invalid key", async () => {
  const os = require("os");
  const path = require("path");
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "API key not valid. Please pass a valid API key." } }),
  });
  const workDir = require("fs").mkdtempSync(path.join(os.tmpdir(), "ac-badkey-"));
  try {
    const result = await overlay.detectAndTranslate(
      path.resolve(__dirname, "fixtures", "tiny.mp4"),
      { apiKey: "bad", workDir },
    );
    assert.equal(result.boxes.length, 0);
    assert.ok(result.errors.length >= 1);
    assert.match(result.errors[0], /API key/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("autoclone places finished videos in a per-user folder under the destination", async () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { AutoCloneController } = require("../src/autoclone/controller");
  const controller = new AutoCloneController();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ac-dest-"));
  const job = { handle: "@Jay_Andrews69", options: { destinationRoot: dest } };
  assert.equal(controller._userDir(job), path.join(dest, "Jay_Andrews69"));
  const job2 = { handle: "@otro", options: { destinationRoot: "" } };
  assert.ok(controller._userDir(job2).endsWith(path.join("jobs", "", "outputs")) || /outputs$/.test(controller._userDir(job2)));
  const check = await controller.checkDestination(dest, "@Jay_Andrews69");
  assert.equal(check.valid, true);
  assert.equal(check.perUser, path.join(dest, "Jay_Andrews69"));
});

test("autopost nextSlots honors selected weekdays and times", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  // Monday 2026-09-14 09:00 UTC. Ask for Mon+Wed at 10:00 and 20:00.
  const now = DateTime.fromISO("2026-09-14T09:00:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["mon", "wed"], times: ["10:00", "20:00"], timezone: "UTC", count: 4, now });
  assert.equal(slots.length, 4);
  assert.equal(slots[0].local, "2026-09-14 10:00");
  assert.equal(slots[1].local, "2026-09-14 20:00");
  assert.equal(slots[2].local, "2026-09-16 10:00");
  assert.equal(slots[3].local, "2026-09-16 20:00");
});

test("autopost nextSlots keeps a 15-minute TikTok lead time", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  // 09:55 and the only time is 10:00 -> too close, must roll to next week.
  const now = DateTime.fromISO("2026-09-14T09:55:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["mon"], times: ["10:00"], timezone: "UTC", count: 1, now });
  assert.equal(slots[0].local, "2026-09-21 10:00");
});

test("autopost nextSlots skips days that are not selected", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  const now = DateTime.fromISO("2026-09-14T09:00:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["fri"], times: ["12:00"], timezone: "UTC", count: 2, now });
  assert.equal(slots[0].local, "2026-09-18 12:00");
  assert.equal(slots[1].local, "2026-09-25 12:00");
});

test("autopost buildPlan maps one video per slot in order", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  const now = DateTime.fromISO("2026-09-14T09:00:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["mon"], times: ["10:00"], timezone: "UTC", count: 3, now });
  const plan = sched.buildPlan(["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"], slots);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].videoName, "a.mp4");
  assert.equal(plan[2].videoName, "c.mp4");
});

test("tiktok schedule date/time use the Web Studio format", () => {
  const { _private } = require("../src/tiktok-uploader");
  const date = new Date(2026, 8, 12, 20, 5);
  assert.equal(_private.formatScheduleDate(date), "2026-09-12");
  assert.equal(_private.formatScheduleTime(date), "20:05");
});

test("tiktok schedule date/time honor the target timezone", () => {
  const { _private } = require("../src/tiktok-uploader");
  // 08:00 UTC is 10:00 in Madrid; near midnight it also changes the day.
  const morning = new Date("2026-09-15T08:00:00Z");
  assert.equal(_private.formatScheduleTime(morning, "Europe/Madrid"), "10:00");
  const nearMidnight = new Date("2026-09-15T23:30:00Z");
  assert.equal(_private.formatScheduleDate(nearMidnight, "Europe/Madrid"), "2026-09-16");
});

test("tiktok splitTime separates hours and minutes", () => {
  const { _private } = require("../src/tiktok-uploader");
  assert.deepEqual(_private.splitTime("10:05"), { hour: "10", minute: "05" });
  assert.deepEqual(_private.splitTime("9:5"), null);
  assert.equal(_private.splitTime(""), null);
});

test("autopost scheduleFolder runs now but schedules natively for the slot", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const calls = [];
  const worker = {
    async createReservedTikTokJob(input) {
      calls.push(input);
      return { id: `job-${calls.length}` };
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-native-"));
  for (const name of ["a.mp4", "b.mp4"]) {
    await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), path.join(dir, name));
  }
  const result = await sched.scheduleFolder({
    accountId: "acct-1",
    folder: dir,
    days: ["mon"],
    times: ["10:00"],
    timezone: "UTC",
    worker,
  });
  assert.equal(result.created.length, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const scheduledAt = new Date(call.scheduledAt).getTime();
    assert.ok(Math.abs(Date.now() - scheduledAt) < 60_000, "job must be due immediately");
    assert.ok(call.nativeScheduledAt, "native TikTok date must be present");
    assert.notEqual(new Date(call.nativeScheduledAt).getTime(), scheduledAt);
  }
  assert.notEqual(
    new Date(calls[0].nativeScheduledAt).getTime(),
    new Date(calls[1].nativeScheduledAt).getTime(),
    "each video must get a different native date"
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("autopost normalizeHashtags accepts array or string and strips #", () => {
  const sched = require("../src/autoclone/scheduler");
  assert.deepEqual(sched.normalizeHashtags(["#viral", "parati", "#madrid"]), ["viral", "parati", "madrid"]);
  assert.deepEqual(sched.normalizeHashtags("viral, #parati  madrid"), ["viral", "parati", "madrid"]);
  assert.deepEqual(sched.normalizeHashtags(["Viral", "#viral", "VIRAL"]), ["Viral"]);
  assert.deepEqual(sched.normalizeHashtags(""), []);
  assert.deepEqual(sched.normalizeHashtags(undefined), []);
});

test("autopost appendHashtags adds missing tags and avoids duplicates", () => {
  const sched = require("../src/autoclone/scheduler");
  assert.equal(sched.appendHashtags("Mira esto", ["viral", "madrid"]), "Mira esto #viral #madrid");
  assert.equal(sched.appendHashtags("", ["viral"]), "#viral");
  assert.equal(sched.appendHashtags("Ya va #viral", ["#viral", "madrid"]), "Ya va #viral #madrid");
  assert.equal(sched.appendHashtags("Sin tags", []), "Sin tags");
});

test("autopost scheduleFolder passes hashtags in the caption and location to the job", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const calls = [];
  const worker = {
    async createReservedTikTokJob(input) {
      calls.push(input);
      return { id: `job-${calls.length}` };
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-hashtags-"));
  await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), path.join(dir, "a.mp4"));
  const result = await sched.scheduleFolder({
    accountId: "acct-1",
    folder: dir,
    days: ["mon"],
    times: ["10:00"],
    timezone: "UTC",
    captionTemplate: "Hola {usuario}",
    hashtags: ["viral", "#parati"],
    location: "Madrid, Spain",
    worker,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].location, "Madrid, Spain");
  assert.ok(calls[0].caption.includes("#viral"));
  assert.ok(calls[0].caption.includes("#parati"));
  assert.equal(result.location, "Madrid, Spain");
  assert.deepEqual(result.hashtags, ["viral", "parati"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("autopost uses each video's own title/description/hashtags plus dashboard hashtags", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const { getMetaPath } = require("../src/queue");
  const calls = [];
  const worker = {
    async createReservedTikTokJob(input) {
      calls.push(input);
      return { id: `job-${calls.length}` };
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-meta-"));
  const video = path.join(dir, "clip.mp4");
  await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), video);
  await fs.writeFile(
    getMetaPath(video),
    JSON.stringify({
      title: "Mi titulo original",
      description: "Descripcion del video #propio",
      hashtags: ["propio"],
    })
  );
  await sched.scheduleFolder({
    accountId: "acct-1",
    folder: dir,
    days: ["mon"],
    times: ["10:00"],
    timezone: "UTC",
    captionTemplate: "Plantilla que no debe usarse {video}",
    hashtags: ["dashboard"],
    worker,
  });
  assert.equal(calls.length, 1);
  const caption = calls[0].caption;
  assert.ok(caption.includes("Mi titulo original"), "uses the video title");
  assert.ok(caption.includes("Descripcion del video"), "uses the video description");
  assert.ok(caption.includes("#propio"), "keeps the video's own hashtag");
  assert.ok(caption.includes("#dashboard"), "adds the dashboard hashtag");
  assert.ok(!caption.includes("Plantilla que no debe usarse"), "does not fall back to the template");
  await fs.rm(dir, { recursive: true, force: true });
});

test("autoclone _copyMetaSidecar always creates a .meta.json for the final video", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const { AutoCloneController } = require("../src/autoclone/controller");
  const { getMetaPath } = require("../src/queue");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-metasidecar-"));
  const call = (src, dst) => AutoCloneController.prototype._copyMetaSidecar.call({}, src, dst);
  try {
    // 1) Source already has a companion: it is copied as-is.
    const src1 = path.join(dir, "with-meta.mp4");
    const dst1 = path.join(dir, "out1.mp4");
    await fs.writeFile(src1, Buffer.alloc(8));
    await fs.writeFile(dst1, Buffer.alloc(8));
    await fs.writeFile(getMetaPath(src1), JSON.stringify({ title: "T", description: "D", hashtags: ["x"] }));
    await call(src1, dst1);
    const copied = JSON.parse(await fs.readFile(getMetaPath(dst1), "utf8"));
    assert.equal(copied.title, "T");

    // 2) No metadata anywhere: an (empty but present) companion is still created.
    const src2 = path.join(dir, "bare.mp4");
    const dst2 = path.join(dir, "out2.mp4");
    await fs.writeFile(src2, Buffer.alloc(8));
    await fs.writeFile(dst2, Buffer.alloc(8));
    await call(src2, dst2);
    const fallback = JSON.parse(await fs.readFile(getMetaPath(dst2), "utf8"));
    assert.deepEqual(fallback.hashtags, []);

    // 3) Only an info.json exists: the companion is built from it.
    const src3 = path.join(dir, "frominfo.mp4");
    const dst3 = path.join(dir, "out3.mp4");
    await fs.writeFile(src3, Buffer.alloc(8));
    await fs.writeFile(dst3, Buffer.alloc(8));
    await fs.writeFile(
      path.join(dir, "frominfo.info.json"),
      JSON.stringify({ title: "Info title", description: "Info desc #tag", tags: ["tag"] })
    );
    await call(src3, dst3);
    const built = JSON.parse(await fs.readFile(getMetaPath(dst3), "utf8"));
    assert.equal(built.title, "Info title");
    assert.deepEqual(built.hashtags, ["tag"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autopost scheduleFolder moves uploaded videos to a 'posted' folder so they are not sent twice", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const worker = { async createReservedTikTokJob() { return { id: "job-1" }; } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-sent-"));
  try {
    await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), path.join(dir, "a.mp4"));
    const result = await sched.scheduleFolder({
      accountId: "acct-1",
      folder: dir,
      days: ["mon"],
      times: ["10:00"],
      timezone: "UTC",
      worker,
    });
    assert.equal(result.created.length, 1);
    const remaining = (await fs.readdir(dir)).filter((n) => n.endsWith(".mp4"));
    assert.deepEqual(remaining, [], "the active folder no longer holds the video");
    const sent = await fs.readdir(path.join(dir, "posted"));
    assert.ok(sent.includes("a.mp4"), "the video is kept in posted");
    // A second run finds nothing new, so it cannot upload it again.
    await assert.rejects(
      () => sched.scheduleFolder({ accountId: "acct-1", folder: dir, days: ["mon"], times: ["10:00"], timezone: "UTC", worker }),
      /No hay videos/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autopost puts 'posted' at the job level when the folder is an Auto Clone 'outputs' dir", () => {
  const sched = require("../src/autoclone/scheduler");
  const path = require("path");
  const jobDir = path.join("/tmp", "autoclone", "jobs", "kimwilliamm-123");
  const outputs = path.join(jobDir, "outputs");
  assert.equal(sched.resolvePostedDir(outputs), path.join(jobDir, "posted"));
  // Any other folder keeps "posted" inside it.
  const custom = path.join("/tmp", "videos", "kimwilliamm");
  assert.equal(sched.resolvePostedDir(custom), path.join(custom, "posted"));
});
