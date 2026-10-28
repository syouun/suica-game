// Headless self-check for index.html (acceptance criteria 1-13 of docs/SPEC.md,
// plus the v1.2 additions: offline single file, BGM, start screen, pause, AUTO PLAY).
// Usage: cd tests && npm install && node selfcheck.js
// Every page runs in an offline browser context and every non-file request is
// recorded and aborted: index.html must work from file:// with no network.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE = "file://" + path.join(ROOT, "index.html") + "?debug=1";
const MATTER = path.join(__dirname, "node_modules/matter-js/build/matter.min.js");
const networkRequests = [];
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

async function openRaw(browser, opts) {
  const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 } }, opts || {}, { offline: true }));
  const page = await context.newPage();
  const errors = [];
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith("file:") || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
    networkRequests.push(url);
    return r.abort();
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.errors = errors;
  page.closeAll = () => context.close();
  await page.goto(PAGE);
  await page.waitForFunction(() => !!window.__fd);
  await page.evaluate(() => { document.getElementById("debugPanel").open = false; });
  return page;
}

async function open(browser, opts) {
  const page = await openRaw(browser, opts);
  await page.evaluate(() => {
    __fd.start();
    __fd.Loop.stop();                 // tests drive the loop themselves (deterministic)
    __fd.Game.autoEnabled = false;    // AUTO PLAY is tested separately
  });
  return page;
}

const results = {};
function record(id, ok, detail) {
  results[id] = { ok: ok, detail: detail };
  console.log((ok ? "OK      " : "CONCERN ") + id + "  " + JSON.stringify(detail));
}

// ---------------------------------------------------------------------------
// R3. start screen + R2. BGM (mute shared with SFX)
async function checkStartScreen(browser) {
  const p = await openRaw(browser);
  const before = await p.evaluate(() => ({
    state: __fd.Game.state,
    overlayVisible: !document.getElementById("startOverlay").classList.contains("hidden"),
    hasStartButton: !!document.getElementById("startBtn"),
    howto: document.querySelector(".howto").innerText,
    pauseDisabled: document.getElementById("pauseBtn").disabled,
    fruits: __fd.world.fruits.length,
    bgm: __fd.BGM.playing,
    audio: !!__fd.Sound.ctx
  }));
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(OUT, "start_screen.png") });
  await p.waitForTimeout(400);
  const stillReady = await p.evaluate(() => __fd.Game.state);
  await p.click("#startBtn");
  await p.waitForTimeout(700);
  const after = await p.evaluate(() => {
    const bgm = __fd.BGM;
    return {
      state: __fd.Game.state,
      overlayHidden: document.getElementById("startOverlay").classList.contains("hidden"),
      pauseEnabled: !document.getElementById("pauseBtn").disabled,
      audioState: __fd.Sound.ctx && __fd.Sound.ctx.state,
      bgmPlaying: bgm.playing,
      bgmStepsScheduled: bgm.step,
      waitingFruitReady: __fd.Game.canDrop()
    };
  });
  // mute (button and M key) silences BGM and SFX through the shared master gain
  await p.click("#muteBtn");
  await p.waitForTimeout(150);
  const muted = await p.evaluate(() => ({ muted: __fd.Sound.muted, master: __fd.Sound.master.gain.value, bgmStillScheduled: __fd.BGM.playing }));
  await p.keyboard.press("KeyM");
  await p.waitForTimeout(150);
  const unmuted = await p.evaluate(() => ({ muted: __fd.Sound.muted, master: +__fd.Sound.master.gain.value.toFixed(3), bgmBus: +__fd.BGM.bus.gain.value.toFixed(3) }));
  record("R3_start_screen", before.state === "ready" && before.overlayVisible && before.hasStartButton && before.pauseDisabled &&
    before.fruits === 0 && !before.bgm && stillReady === "ready" && after.state === "playing" && after.overlayHidden && after.pauseEnabled && after.waitingFruitReady,
  { before: before, after: { state: after.state, overlayHidden: after.overlayHidden, pauseEnabled: after.pauseEnabled, waitingFruitReady: after.waitingFruitReady } });
  record("R2_bgm_and_mute", after.bgmPlaying && after.bgmStepsScheduled > 0 && muted.muted && muted.master < 0.01 && muted.bgmStillScheduled &&
    !unmuted.muted && unmuted.master > 0.55 && unmuted.bgmBus > 0 && unmuted.bgmBus <= 0.3 + 1e-6,
  { audioState: after.audioState, bgmPlaying: after.bgmPlaying, stepsScheduledIn700ms: after.bgmStepsScheduled, muted: muted, unmuted: unmuted });
  // keyboard start on a fresh page (Space / Enter)
  const q = await openRaw(browser);
  await q.keyboard.press("Enter");
  const keyStart = await q.evaluate(() => ({ state: __fd.Game.state, bgm: __fd.BGM.playing }));
  await q.closeAll();
  record("R3_keyboard_start", keyStart.state === "playing" && keyStart.bgm, keyStart);
  if (p.errors.length) results.pageErrors = (results.pageErrors || []).concat(p.errors);
  await p.closeAll();
}

// R4. pause: physics, drops, particles, idle timer and game-over timer stand still
async function checkPause(browser) {
  const p = await open(browser);
  const res = await p.evaluate(() => {
    __fd.Game.autoEnabled = true;
    __fd.spawn(6, 120, -60);
    __fd.spawn(6, 120 + 84, 300);          // falls, then merges with the first one later
    __fd.spawn(3, 300, 0);
    const pinned = __fd.spawn(5, 330, 0);
    __fd.pin(pinned);                      // keeps the deadline timer running
    __fd.stepFrames(60, 1.4);
    __fd.Effects.juice(200, 200, 8, 60, 1, 1);
    __fd.stepFrames(60, 0.1);
    const snap = () => {
      const st = __fd.getState();
      return JSON.stringify({ t: st.time, f: st.fruits, o: st.overTimer, i: st.idleMs, p: __fd.Effects.particles.map((q) => [q.x, q.y, q.age]) });
    };
    return { snapA: snap(), overTimerA: __fd.Game.overTimer, idleA: __fd.Game.idleMs, particles: __fd.Effects.particles.length };
  });
  await p.keyboard.press("KeyP");
  // the key press itself is user input (idle timer -> 0), so the reference snapshot is taken after pausing
  const paused1 = await p.evaluate(() => {
    const st = __fd.getState();
    return {
      paused: __fd.Game.paused, overlay: !document.getElementById("pauseOverlay").classList.contains("hidden"),
      title: document.querySelector(".pause-title").innerText, resumeBtn: document.getElementById("resumeBtn").innerText,
      snap: JSON.stringify({ t: st.time, f: st.fruits, o: st.overTimer, i: st.idleMs, p: __fd.Effects.particles.map((q) => [q.x, q.y, q.age]) }),
      overTimer: st.overTimer
    };
  });
  await p.evaluate(() => __fd.renderOnce());
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(OUT, "pause_screen.png") });
  const during = await p.evaluate(() => {
    const snap = () => {
      const st = __fd.getState();
      return JSON.stringify({ t: st.time, f: st.fruits, o: st.overTimer, i: st.idleMs, p: __fd.Effects.particles.map((q) => [q.x, q.y, q.age]) });
    };
    __fd.stepFrames(60, 6);                // 6 s paused: longer than the idle (5 s) and game-over (2 s) timers
    const dropped = __fd.Game.drop();
    return { snapB: snap(), dropWhilePaused: dropped, state: __fd.Game.state, auto: __fd.Game.auto, bgmDucked: __fd.BGM.ducked };
  });
  await p.keyboard.press("Escape");
  const resumed = await p.evaluate(() => {
    const t0 = __fd.world.time;
    __fd.stepFrames(60, 0.5);
    return { paused: __fd.Game.paused, overlayHidden: document.getElementById("pauseOverlay").classList.contains("hidden"), advancedMs: Math.round(__fd.world.time - t0), bgmDucked: __fd.BGM.ducked };
  });
  // button toggles too
  await p.click("#pauseBtn");
  const byButton = await p.evaluate(() => __fd.Game.paused);
  await p.click("#resumeBtn");
  const byResume = await p.evaluate(() => __fd.Game.paused);
  const frozen = paused1.snap === during.snapB && paused1.overTimer > 0;
  delete paused1.snap;
  record("R4_pause", paused1.paused && paused1.overlay && frozen && !during.dropWhilePaused && during.state === "playing" && !during.auto && during.bgmDucked &&
    !resumed.paused && resumed.overlayHidden && resumed.advancedMs > 450 && !resumed.bgmDucked && byButton === true && byResume === false,
  { pausedByP: paused1, everythingFrozenFor6s: frozen, particlesFrozen: res.particles, dropWhilePaused: during.dropWhilePaused, gameOverWhilePaused: during.state !== "playing", autoWhilePaused: during.auto,
    resumedByEsc: resumed, pauseButton: byButton, resumeButton: !byResume });
  if (p.errors.length) results.pageErrors = (results.pageErrors || []).concat(p.errors);
  await p.closeAll();
}

// R5. AUTO PLAY after 5 s without input, immediate hand-back on input
async function checkAutoPlay(browser) {
  const p = await open(browser);
  const run = await p.evaluate(() => {
    const G = __fd.Game;
    __fd.reset();
    __fd.Loop.stop();
    G.autoEnabled = true;
    G.noGameOver = true;
    const drops = [];
    const origDrop = G.drop.bind(G);
    G.drop = function () {
      const stage = G.current, x = G.clampX(G.dropX, stage);
      const land = __fd.AutoPlay.landing(x, __fd.FRUITS[stage].r, __fd.world.fruits);
      const ok = origDrop();
      if (ok) drops.push({ t: __fd.world.time, x: x, stage: stage, auto: G.auto, onTwin: !!(land.hit && land.hit.stage === stage) });
      return ok;
    };
    __fd.stepFrames(60, 4.9);
    const at49 = G.auto;
    __fd.stepFrames(60, 0.2);
    const at51 = G.auto;
    const badge = !document.getElementById("autoBadge").classList.contains("hidden");
    const badgeText = document.getElementById("autoBadge").innerText;
    __fd.stepFrames(60, 60);
    const autoDrops = drops.filter((d) => d.auto);
    const gaps = [];
    for (let i = 1; i < autoDrops.length; i++) gaps.push(autoDrops[i].t - autoDrops[i - 1].t);
    const xs = autoDrops.map((d) => d.x);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length);
    return {
      autoAt4_9s: at49, autoAt5_1s: at51, badgeShown: badge, badgeText: badgeText,
      autoDropsIn60s: autoDrops.length, firstAutoDropMs: autoDrops.length ? Math.round(autoDrops[0].t) : null,
      gapMinMs: Math.round(Math.min.apply(null, gaps)), gapMaxMs: Math.round(Math.max.apply(null, gaps)),
      xSpreadSd: +sd.toFixed(1), xMin: Math.round(Math.min.apply(null, xs)), xMax: Math.round(Math.max.apply(null, xs)),
      landedOnTwin: autoDrops.filter((d) => d.onTwin).length, score: G.score, merges: __fd.world.mergeCount
    };
  });
  await p.evaluate(() => __fd.renderOnce());
  await p.screenshot({ path: path.join(OUT, "auto_play.png") });
  // real mouse movement over the field hands control back immediately
  const box = await p.locator("#game").boundingBox();
  await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await p.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.5);
  const afterMouse = await p.evaluate(() => ({ auto: __fd.Game.auto, idleMs: __fd.Game.idleMs, badgeHidden: document.getElementById("autoBadge").classList.contains("hidden"), dropX: Math.round(__fd.Game.dropX) }));
  const backToAuto = await p.evaluate(() => {
    __fd.stepFrames(60, 4.9);
    const a = __fd.Game.auto;
    __fd.stepFrames(60, 0.2);
    return { at4_9s: a, at5_1s: __fd.Game.auto };
  });
  await p.keyboard.down("ArrowLeft");
  const afterKey = await p.evaluate(() => ({ auto: __fd.Game.auto, idleMs: __fd.Game.idleMs }));
  const keyMoves = await p.evaluate(() => { const x0 = __fd.Game.dropX; __fd.stepFrames(60, 0.3); return Math.round(x0 - __fd.Game.dropX); });
  await p.keyboard.up("ArrowLeft");
  if (p.errors.length) results.pageErrors = (results.pageErrors || []).concat(p.errors);
  await p.closeAll();
  // touch hand-back on a phone
  const q = await open(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const tq = await q.evaluate(() => { __fd.Game.autoEnabled = true; __fd.stepFrames(60, 5.2); return __fd.Game.auto; });
  const gbox = await q.locator("#game").boundingBox();
  await q.touchscreen.tap(gbox.x + gbox.width * 0.6, gbox.y + gbox.height * 0.3);
  const afterTap = await q.evaluate(() => ({ auto: __fd.Game.auto, idleMs: __fd.Game.idleMs }));
  if (q.errors.length) results.pageErrors = (results.pageErrors || []).concat(q.errors);
  await q.closeAll();
  record("R5_auto_play", !run.autoAt4_9s && run.autoAt5_1s && run.badgeShown && run.autoDropsIn60s >= 20 &&
    run.gapMinMs >= 1500 - 20 && run.gapMaxMs <= 2500 + 400 && run.xSpreadSd > 40 &&
    !afterMouse.auto && afterMouse.idleMs === 0 && afterMouse.badgeHidden && !backToAuto.at4_9s && backToAuto.at5_1s &&
    !afterKey.auto && afterKey.idleMs === 0 && keyMoves > 50 && tq === true && !afterTap.auto && afterTap.idleMs === 0,
  { idleToAuto: run, mouseHandBack: afterMouse, autoAgainAfterIdle: backToAuto, keyHandBack: Object.assign(afterKey, { movedLeftU: keyMoves }), touchHandBack: { autoBeforeTap: tq, afterTap: afterTap } });
}

(async () => {
  const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
  const page = await open(browser);

  // ---- 1. merges and scores for every stage, incl. watermelon + watermelon
  const c1 = await page.evaluate(() => {
    const out = [];
    for (let n = 1; n <= 11; n++) {
      __fd.reset();
      __fd.Loop.stop();
      __fd.Game.noGameOver = true;
      const r = __fd.FRUITS[n].r, H = __fd.CONFIG.H;
      const before = __fd.Game.score;
      __fd.spawn(n, 200 - r, H - r);
      __fd.spawn(n, 200 + r - 1, H - r);
      __fd.stepFrames(60, 1);
      const st = __fd.getState();
      const expectStage = n < 11 ? n + 1 : null;
      const expectPts = __fd.FRUITS[n < 11 ? n + 1 : 11].points;
      const okFruits = expectStage === null ? st.fruits.length === 0 : (st.fruits.length === 1 && st.fruits[0].stage === expectStage);
      out.push({ n: n, result: st.fruits.map((f) => f.stage), gained: st.score - before, expected: expectPts, ok: okFruits && st.score - before === expectPts });
    }
    return out;
  });
  record("1_merge_and_score", c1.every((x) => x.ok), c1.map((x) => x.n + "->" + JSON.stringify(x.result) + " +" + x.gained + "(exp " + x.expected + ")"));

  // ---- 2. 3+ simultaneous identical fruits: conservation of 2^(stage-1)
  const c2 = await page.evaluate(() => {
    const out = [];
    for (const n of [1, 3, 5, 7]) {
      for (const k of [3, 4, 5, 6]) {
        __fd.reset();
        __fd.Loop.stop();
        __fd.Game.noGameOver = true;
        const r = __fd.FRUITS[n].r, H = __fd.CONFIG.H;
        const pts = [];
        for (let i = 0; i < k; i++) {
          const a = i * (2 * Math.PI / k);
          pts.push([200 + Math.cos(a) * r * 0.95, H - 3 * r + Math.sin(a) * r * 0.95]);
        }
        for (const p of pts) __fd.spawn(n, p[0], p[1]);
        const before = k * Math.pow(2, n - 1);
        let stepsOk = true, minVal = Infinity, maxVal = -Infinity;
        for (let s = 0; s < 180; s++) {
          __fd.stepFrames(60, 1 / 60);
          const st = __fd.getState();
          const v = st.fruits.reduce((t, f) => t + Math.pow(2, f.stage - 1), 0);
          minVal = Math.min(minVal, v);
          maxVal = Math.max(maxVal, v);
          if (v !== before) stepsOk = false;
        }
        const st = __fd.getState();
        const ids = st.fruits.map((f) => f.id);
        const unique = new Set(ids).size === ids.length;
        out.push({ n: n, k: k, final: st.fruits.map((f) => f.stage).sort((a, b) => a - b), conserved: stepsOk, unique: unique, ok: stepsOk && unique, min: minVal, max: maxVal, expected: before });
      }
    }
    return out;
  });
  record("2_simultaneous_merge", c2.every((x) => x.ok), c2.map((x) => x.n + "x" + x.k + "->" + JSON.stringify(x.final) + (x.ok ? "" : " BAD")));

  // ---- 3 & 13. heavy random play: no tunnelling / nothing leaves the container
  const c3 = await page.evaluate(() => {
    __fd.reset();
    __fd.Loop.stop();
    __fd.Game.noGameOver = true;
    let seed = 12345;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let worstOut = 0, minTop = Infinity, maxUp = 0, maxCount = 0;
    const check = () => {
      for (const f of __fd.world.fruits) {
        const p = f.body.position;
        worstOut = Math.max(worstOut, (f.r - p.x), (p.x + f.r - 400), (p.y + f.r - 500));
        minTop = Math.min(minTop, p.y - f.r);
        const v = Matter.Body.getVelocity(f.body);
        if (__fd.world.time - f.spawnTime > 300) maxUp = Math.max(maxUp, -v.y * 60);
      }
      maxCount = Math.max(maxCount, __fd.world.fruits.length);
    };
    for (let i = 0; i < 260; i++) {
      const stage = 1 + Math.floor(rnd() * 5);
      const r = __fd.FRUITS[stage].r;
      if (i % 10 === 9) {
        // high speed drop from far above the container at the maximum speed
        __fd.spawn(stage, r + rnd() * (400 - 2 * r), -900, 0, 5000);
      } else {
        __fd.spawn(stage, r + rnd() * (400 - 2 * r), -60);
      }
      for (let s = 0; s < 12; s++) { __fd.stepFrames(60, 1 / 60); check(); }
    }
    for (let s = 0; s < 600; s++) { __fd.stepFrames(60, 1 / 60); check(); }
    const st = __fd.getState();
    return { rescue: st.rescue, wallClamp: st.wallClamp, worstOutside: +worstOut.toFixed(3), minTop: +minTop.toFixed(1), maxUpSpeedAfterSpawn: +maxUp.toFixed(1), maxFruits: maxCount, finalFruits: st.fruits.length, merges: __fd.world.mergeCount, score: st.score };
  });
  record("3_no_tunnelling", c3.rescue === 0 && c3.worstOutside <= 1.5, c3);

  // ---- 13. dense container + deliberate chain merges at the bottom
  const c13 = await page.evaluate(() => {
    const runs = [];
    for (let trial = 0; trial < 6; trial++) {
      __fd.reset();
      __fd.Loop.stop();
      __fd.Game.noGameOver = true;
      let seed = 777 + trial;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      // bottom row: pairs of identical fruits that will merge immediately, packed under a full load
      const pairStage = 6 + (trial % 4);
      const r = __fd.FRUITS[pairStage].r;
      __fd.spawn(pairStage, r + 2, 500 - r);
      __fd.spawn(pairStage, 3 * r + 1, 500 - r);
      // keep them apart until the load is on top
      const pinned = __fd.world.fruits.slice();
      pinned.forEach((f) => Matter.Body.setStatic(f.body, true));
      for (let i = 0; i < 70; i++) {
        const st = 1 + Math.floor(rnd() * 4);
        const rr = __fd.FRUITS[st].r;
        __fd.spawn(st, rr + rnd() * (400 - 2 * rr), -60 - (i % 5) * 70);
        __fd.stepFrames(60, 0.05);
      }
      __fd.world.mergeEnabled = false;
      __fd.stepFrames(60, 2);
      __fd.world.mergeEnabled = true;
      pinned.forEach((f) => { Matter.Body.setStatic(f.body, false); f.merging = false; });
      // push them together so they merge under the pile
      Matter.Body.setPosition(pinned[1].body, { x: pinned[0].body.position.x + 2 * r - 1, y: pinned[1].body.position.y });
      let worstOut = 0, maxSpeed = 0, minTop = Infinity;
      for (let s = 0; s < 240; s++) {
        __fd.stepFrames(60, 1 / 60);
        for (const f of __fd.world.fruits) {
          const p = f.body.position;
          worstOut = Math.max(worstOut, f.r - p.x, p.x + f.r - 400, p.y + f.r - 500);
          minTop = Math.min(minTop, p.y - f.r);
          const v = Matter.Body.getVelocity(f.body);
          maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y) * 60);
        }
      }
      runs.push({ pairStage: pairStage, fruits: __fd.world.fruits.length, rescue: __fd.world.rescueCount, wallClamp: __fd.world.wallClampCount, worstOutside: +worstOut.toFixed(2), minTop: +minTop.toFixed(1), maxSpeed: +maxSpeed.toFixed(0), merges: __fd.world.mergeCount });
    }
    return runs;
  });
  record("13_push_stays_inside", c13.every((r) => r.rescue === 0 && r.worstOutside <= 1.5), c13);

  // ---- 4. deadline grace + continuous 2 s rule
  const c4 = await page.evaluate(() => {
    const out = {};
    __fd.reset();
    __fd.Loop.stop();
    __fd.Game.noGameOver = false;
    __fd.Game.forcedStage = 5;
    __fd.Game.current = 5;
    // drop five large fruits in a row through the deadline (normal play)
    let sawOverEarly = false;
    for (let i = 0; i < 5; i++) {
      __fd.drop(80 + i * 60, 5);
      for (let s = 0; s < 36; s++) {
        __fd.stepFrames(60, 1 / 60);
        if (__fd.Game.overState) sawOverEarly = true;
      }
    }
    __fd.stepFrames(60, 2);
    out.normalDrops = { state: __fd.getState().state, sawOverState: sawOverEarly };
    __fd.Game.forcedStage = 0;
    // a fruit held above the line: game over exactly after 1 s grace + 2 s
    __fd.reset();
    __fd.Loop.stop();
    __fd.Game.noGameOver = false;
    const id = __fd.spawn(5, 200, 0);
    __fd.pin(id);
    let t = 0, overAt = null;
    while (t < 4000) {
      __fd.stepFrames(60, 1 / 60);
      t = __fd.world.time;
      if (overAt === null && __fd.Game.state !== "playing") { overAt = t; break; }
    }
    out.heldAbove = { gameOverAtMs: Math.round(overAt), expectedMs: 3000 };
    // interrupted: above for 1.5 s, below, above again -> timer restarts
    __fd.reset();
    __fd.Loop.stop();
    const id2 = __fd.spawn(5, 200, 0);
    __fd.pin(id2);
    __fd.stepFrames(60, 2.5);
    const f = __fd.world.fruits.find((q) => q.id === id2);
    Matter.Body.setPosition(f.body, { x: 200, y: 300 });
    __fd.stepFrames(60, 0.2);
    Matter.Body.setPosition(f.body, { x: 200, y: 0 });
    __fd.stepFrames(60, 1.9);
    const s1 = __fd.Game.state;
    __fd.stepFrames(60, 0.2);
    out.interrupted = { after1_9s: s1, after2_1s: __fd.Game.state };
    // game over sequence -> result panel -> retry
    __fd.stepFrames(60, 4);
    const shown = document.getElementById("result").classList.contains("show");
    const st = __fd.Game.state;
    document.getElementById("retryBtn").click();
    out.sequence = { state: st, resultShown: shown, afterRetry: __fd.Game.state, fruitsAfterRetry: __fd.world.fruits.length };
    return out;
  });
  record("4_deadline_grace", c4.normalDrops.state === "playing" && !c4.normalDrops.sawOverState &&
    Math.abs(c4.heldAbove.gameOverAtMs - 3000) <= 20 && c4.interrupted.after1_9s === "playing" && c4.interrupted.after2_1s !== "playing" &&
    c4.sequence.resultShown && c4.sequence.afterRetry === "playing" && c4.sequence.fruitsAfterRetry === 0, c4);

  // ---- 5. frame-rate independence (30/60/120/144 Hz)
  const c5 = await page.evaluate(() => {
    const scenario = (hz) => {
      __fd.reset();
      __fd.Loop.stop();
      __fd.Game.noGameOver = true;
      __fd.Loop.acc = 0;
      const spec = [[5, 120, -60], [3, 140, -200], [1, 260, -60], [4, 200, -400], [2, 210, -120], [6, 300, -600]];
      for (const s of spec) __fd.spawn(s[0], s[1], s[2]);
      __fd.stepFrames(hz, 3);
      const st = __fd.getState();
      return { time: st.time, fruits: st.fruits.map((f) => [f.stage, f.x, f.y, f.angle]) };
    };
    const base = scenario(60);
    const out = { base60: { time: base.time, n: base.fruits.length } };
    for (const hz of [30, 120, 144]) {
      const s = scenario(hz);
      let maxDiff = 0;
      if (s.fruits.length !== base.fruits.length) maxDiff = Infinity;
      else s.fruits.forEach((f, i) => { maxDiff = Math.max(maxDiff, Math.abs(f[1] - base.fruits[i][1]), Math.abs(f[2] - base.fruits[i][2]), Math.abs(f[3] - base.fruits[i][3])); });
      out["hz" + hz] = { time: s.time, maxPositionDiff: maxDiff };
    }
    return out;
  });
  record("5_framerate_independent", ["hz30", "hz120", "hz144"].every((k) => c5[k].maxPositionDiff < 1e-6 && Math.abs(c5[k].time - c5.base60.time) < 1e-6), c5);

  // ---- 6. performance with 30+ fruits (CPU time per frame: physics + render)
  const c6 = await page.evaluate(() => {
    __fd.reset();
    __fd.Loop.stop();
    __fd.Game.noGameOver = true;
    __fd.world.mergeEnabled = false;
    let seed = 99;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 45; i++) {
      const st = 1 + Math.floor(rnd() * 6);
      const r = __fd.FRUITS[st].r;
      __fd.spawn(st, r + rnd() * (400 - 2 * r), -60 - i * 15);
      __fd.stepFrames(60, 0.1);
    }
    __fd.stepFrames(60, 3);
    const n = __fd.world.fruits.length;
    const times = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      __fd.Loop.tick(1000 / 60);
      __fd.renderOnce();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    __fd.world.mergeEnabled = true;
    return { fruits: n, avgMs: +avg.toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), maxMs: +times[times.length - 1].toFixed(2), budgetMs: 16.7 };
  });
  record("6_performance_30plus", c6.fruits >= 30 && c6.p95Ms < 10, c6);

  // ---- 7. ten retries do not leak
  const c7 = await page.evaluate(() => {
    const samples = [];
    const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
    for (let k = 0; k < 11; k++) {
      __fd.reset();
      __fd.Loop.stop();
      __fd.Game.noGameOver = true;
      for (let i = 0; i < 35; i++) {
        const st = 1 + (i % 5);
        const r = __fd.FRUITS[st].r;
        __fd.spawn(st, r + ((i * 53) % (400 - 2 * r)), -60 - i * 20);
      }
      __fd.stepFrames(60, 4);
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) { __fd.Loop.tick(1000 / 60); __fd.renderOnce(); }
      const frameMs = (performance.now() - t0) / 60;
      const st = __fd.getState();
      samples.push({ round: k, bodies: st.bodies, listeners: st.listeners, effects: st.effects, frameMs: +frameMs.toFixed(2), heapMB: heap() && +(heap() / 1048576).toFixed(1) });
    }
    __fd.reset();
    __fd.Loop.stop();
    const fresh = __fd.getState();
    return { samples: samples, afterFinalReset: { bodies: fresh.bodies, listeners: fresh.listeners, effects: fresh.effects } };
  });
  const s7 = c7.samples;
  record("7_retry_no_leak", c7.afterFinalReset.bodies === 3 && c7.afterFinalReset.listeners === 2 &&
    s7[10].frameMs < s7[1].frameMs * 1.6 + 1, { first: s7[1], last: s7[10], afterFinalReset: c7.afterFinalReset });

  // ---- 10. measurement test
  const c10 = await page.evaluate(() => {
    const m = __fd.Tests.measureAll();
    m.rows.forEach((r) => delete r.trace);
    return m;
  });
  record("10_measurement", c10.rows.every((r) => r.fallEval.ok && r.bounceEval.ok && r.countEval.ok && r.settleEval.ok),
    c10.rows.map((r) => ({ stage: r.stage, fall: r.fallEval.text, bounce: r.bounceEval.text, bounces: r.countEval.text, settle: r.settleEval.text })));

  // ---- 12. watermelon on 10+ small fruits for 30 s
  // "sink" is measured after the pile has settled (5 s -> 30 s). A drop of the
  // watermelon is only accepted when it is explained by a fruit being squeezed
  // out from underneath (collapse) and no lasting overlap remains.
  const c12 = await page.evaluate(() => [-90, -60, -25, 0, 15, 45, 80].map((o) => {
    const s = __fd.Tests.stackTest({ offsetX: o });
    return { offsetX: o, underStart: s.underStart, under: s.under, maxPen: +s.maxPen.toFixed(2), endPen: +s.endPen.toFixed(2), floorPen: +s.maxFloorPen.toFixed(2), sink: +s.sink.toFixed(2), belowFloor: s.belowFloor, rescue: s.rescue, wallClamp: s.wallClamp };
  }));
  c12.forEach((r) => { r.collapse = r.under < r.underStart; r.ok = r.under >= 10 && r.maxPen <= 2 && r.endPen <= 1 && r.belowFloor === 0 && r.rescue === 0 && (Math.abs(r.sink) <= 1 || r.collapse); });
  record("12_stack_30s", c12.every((r) => r.ok), c12);

  results.pageErrors = page.errors.slice();
  await page.closeAll();

  // ---- 8. high-DPI rendering & 11. screen size independence
  const sizes = [
    { name: "desktop_dpr2", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
    { name: "phone_dpr3", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    { name: "small_dpr1", viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }
  ];
  const c8 = [], c11 = [];
  for (const s of sizes) {
    const p = await open(browser, { viewport: s.viewport, deviceScaleFactor: s.deviceScaleFactor, isMobile: !!s.isMobile, hasTouch: !!s.hasTouch });
    const info = await p.evaluate(() => {
      const c = document.getElementById("game");
      const rect = c.getBoundingClientRect();
      __fd.reset();
      __fd.Loop.stop();
      __fd.Game.noGameOver = true;
      const spec = [[5, 120, -60], [3, 140, -200], [1, 260, -60], [4, 200, -400], [2, 210, -120], [9, 300, -600], [11, 150, -900]];
      for (const q of spec) __fd.spawn(q[0], q[1], q[2]);
      __fd.stepFrames(60, 4);
      __fd.renderOnce();
      return {
        cssW: rect.width, cssH: rect.height, pxW: c.width, pxH: c.height, dpr: devicePixelRatio,
        pixelRatioMatches: Math.abs(c.width / rect.width - devicePixelRatio) < 0.02,
        fitsViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
        pageScrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
        fruits: __fd.getState().fruits.map((f) => [f.stage, +f.x.toFixed(6), +f.y.toFixed(6)])
      };
    });
    await p.screenshot({ path: path.join(OUT, s.name + ".png") });
    // resize mid-game: physics state must not change
    const before = await p.evaluate(() => __fd.getState().fruits.map((f) => [f.x, f.y, f.angle]));
    await p.setViewportSize({ width: Math.round(s.viewport.width * 0.7), height: Math.round(s.viewport.height * 0.8) });
    await p.waitForTimeout(250);
    const after = await p.evaluate(() => ({ fruits: __fd.getState().fruits.map((f) => [f.x, f.y, f.angle]), pxW: document.getElementById("game").width }));
    const unchanged = JSON.stringify(before) === JSON.stringify(after.fruits);
    c8.push({ name: s.name, cssW: Math.round(info.cssW), pxW: info.pxW, dpr: info.dpr, pixelRatioMatches: info.pixelRatioMatches, fitsViewport: info.fitsViewport, pageScrolls: info.pageScrolls });
    c11.push({ name: s.name, fruits: info.fruits, resizeKeepsPhysics: unchanged, canvasResized: after.pxW !== info.pxW });
    if (p.errors.length) results.pageErrors = (results.pageErrors || []).concat(p.errors);
    await p.closeAll();
  }
  record("8_high_dpi_crisp", c8.every((x) => x.pixelRatioMatches && x.fitsViewport && !x.pageScrolls), c8);
  const ref = JSON.stringify(c11[0].fruits);
  record("11_screen_size_independent", c11.every((x) => JSON.stringify(x.fruits) === ref && x.resizeKeepsPhysics && x.canvasResized),
    c11.map((x) => ({ name: x.name, sameTrajectoryAsDesktop: JSON.stringify(x.fruits) === ref, resizeKeepsPhysics: x.resizeKeepsPhysics })));

  // ---- v1.2 features: start screen, BGM, pause, AUTO PLAY
  await checkStartScreen(browser);
  await checkPause(browser);
  await checkAutoPlay(browser);

  // ---- 9 / R1. rights + offline single file: no external resources at all
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const urls = (html.match(/https?:\/\/[^\s"')]+/g) || []);
  const srcAttrs = (html.match(/\s(?:src|href)\s*=\s*["'][^"']*["']/gi) || []);
  const netApis = (html.match(/\bfetch\s*\(|XMLHttpRequest|new\s+Audio\s*\(|new\s+WebSocket|importScripts|@import|url\(\s*["']?https?:/g) || []);
  const assets = (html.match(/\.(png|jpe?g|gif|webp|mp3|ogg|wav|woff2?|ttf)\b/gi) || []);
  const lib = fs.readFileSync(MATTER, "utf8").replace(/\n+$/, "");
  const inlined = html.includes('<script id="matter-js-0.19.0">\n' + lib + "\n</script>");
  record("9_R1_offline_single_file", inlined && srcAttrs.length === 0 && netApis.length === 0 && assets.length === 0 &&
    urls.every((u) => u === "http://brm.io/matter-js/") && networkRequests.length === 0,
  { matterInlinedVerbatim: inlined, srcOrHrefAttributes: srcAttrs, networkApis: netApis, assetRefs: assets, urlsInText: urls, runtimeNetworkRequests: networkRequests });

  results.pageErrors = results.pageErrors || [];
  record("no_page_errors", results.pageErrors.length === 0, results.pageErrors);

  fs.writeFileSync(path.join(OUT, "selfcheck.json"), JSON.stringify(results, null, 2));
  await browser.close();
  const failed = Object.keys(results).filter((k) => results[k] && results[k].ok === false);
  console.log(failed.length ? "\nCONCERNS: " + failed.join(", ") : "\nALL CHECKS OK");
  process.exitCode = failed.length ? 1 : 0;
})();
