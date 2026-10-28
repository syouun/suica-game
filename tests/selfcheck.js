// Headless self-check for index.html (acceptance criteria 1-13 of docs/SPEC.md).
// Usage: cd tests && npm install && node selfcheck.js
// The page loads Matter.js from cdnjs; here the request is answered with the
// identical matter-js@0.19.0 build from node_modules so the test runs offline.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE = "file://" + path.join(ROOT, "index.html") + "?debug=1";
const MATTER = path.join(__dirname, "node_modules/matter-js/build/matter.min.js");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

async function open(browser, opts) {
  const page = await browser.newPage(opts || { viewport: { width: 1280, height: 800 } });
  const errors = [];
  await page.route("**/matter.min.js", (r) => r.fulfill({ path: MATTER, contentType: "application/javascript" }));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(PAGE);
  await page.waitForFunction(() => !!window.__fd);
  await page.evaluate(() => {
    __fd.start();
    __fd.Loop.stop();                 // tests drive the loop themselves (deterministic)
    document.getElementById("debugPanel").open = false;
  });
  page.errors = errors;
  return page;
}

const results = {};
function record(id, ok, detail) {
  results[id] = { ok: ok, detail: detail };
  console.log((ok ? "OK      " : "CONCERN ") + id + "  " + JSON.stringify(detail));
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
  await page.close();

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
    await p.close();
  }
  record("8_high_dpi_crisp", c8.every((x) => x.pixelRatioMatches && x.fitsViewport && !x.pageScrolls), c8);
  const ref = JSON.stringify(c11[0].fruits);
  record("11_screen_size_independent", c11.every((x) => JSON.stringify(x.fruits) === ref && x.resizeKeepsPhysics && x.canvasResized),
    c11.map((x) => ({ name: x.name, sameTrajectoryAsDesktop: JSON.stringify(x.fruits) === ref, resizeKeepsPhysics: x.resizeKeepsPhysics })));

  // ---- 9. rights: static scan for external assets (fonts, images, audio) besides Matter.js
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const urls = (html.match(/https?:\/\/[^\s"')]+/g) || []);
  const assets = (html.match(/\.(png|jpe?g|gif|webp|mp3|ogg|wav|woff2?|ttf)\b/gi) || []);
  record("9_no_external_assets", urls.length === 1 && /matter-js\/0\.19\.0\/matter\.min\.js$/.test(urls[0]) && assets.length === 0, { urls: urls, assetRefs: assets });

  results.pageErrors = results.pageErrors || [];
  record("no_page_errors", results.pageErrors.length === 0, results.pageErrors);

  fs.writeFileSync(path.join(OUT, "selfcheck.json"), JSON.stringify(results, null, 2));
  await browser.close();
  const failed = Object.keys(results).filter((k) => results[k] && results[k].ok === false);
  console.log(failed.length ? "\nCONCERNS: " + failed.join(", ") : "\nALL CHECKS OK");
  process.exitCode = failed.length ? 1 : 0;
})();
