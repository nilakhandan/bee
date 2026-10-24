/* =====================================================================
   RoboRescue — dashboard logic (vanilla JS)
   =====================================================================

   >>> CONFIGURATION — EDIT AFTER YOUR ESP32 HARDWARE IS SET UP <<<
   All addresses below are PLACEHOLDERS. Replace them with the real IPs
   printed in the Arduino Serial Monitor. You can also change them at
   runtime in the Settings dialog (saved in this browser only).
   ===================================================================== */
const CONFIG = {
  DEMO_MODE: true,                          // true = no real commands are ever sent
  ESP32_BASE_URL: "http://192.168.1.100",   // ESP32 DevKit V1 (motors + HC-SR04)
  CAMERA_STREAM_URL: "",                    // e.g. "http://192.168.1.101:81/stream"  (ESP32-CAM)
  CAMERA_CAPTURE_URL: "",                   // e.g. "http://192.168.1.101/capture"

  // Endpoint convention — must match the ESP32 firmware
  CMD_PATH: "/cmd",                         // GET /cmd?m=F|B|L|R|S
  STATUS_PATH: "/api/status",               // GET -> {"distance_cm":42.5,...}

  REQUEST_TIMEOUT_MS: 1500,                 // abort slow requests
  HOLD_REPEAT_MS: 200,                      // resend while button held (for firmware safety timeout)
  STATUS_POLL_MS: 1000,                     // sensor polling interval
  OBSTACLE_THRESHOLD_CM: 20
};

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");
const nowStr = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const MOVE_NAMES = { F: "Forward", B: "Backward", L: "Left", R: "Right", S: "Stopped" };

const state = {
  hardware: false,        // false = demo mode
  linked: false,          // ESP32 reachable
  camOk: false,
  held: null,             // currently held command letter
  holdTimer: null,
  moving: "S",
  auto: false,
  threshold: CONFIG.OBSTACLE_THRESHOLD_CM,
  distance: null,
  logPaused: false,
  missionStart: Date.now(),
  pollTimer: null,
  failCount: 0
};

/* ---------- URL validation & saved settings ---------- */
/* Returns a clean URL string, "" if empty, or null if invalid. */
function cleanUrl(v) {
  v = (v || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href.replace(/\/$/, "");
  } catch (e) { return null; }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("roborescue.settings") || "{}");
    ["ESP32_BASE_URL", "CAMERA_STREAM_URL", "CAMERA_CAPTURE_URL"].forEach((k) => {
      if (typeof s[k] === "string" && cleanUrl(s[k]) !== null) CONFIG[k] = s[k];
    });
  } catch (e) { /* storage unavailable: use defaults */ }
}
function saveSettings() {
  try {
    localStorage.setItem("roborescue.settings", JSON.stringify({
      ESP32_BASE_URL: CONFIG.ESP32_BASE_URL,
      CAMERA_STREAM_URL: CONFIG.CAMERA_STREAM_URL,
      CAMERA_CAPTURE_URL: CONFIG.CAMERA_CAPTURE_URL
    }));
  } catch (e) { log("Could not save settings in this browser.", "warn"); }
}
const hardwareConfigured = () => !!cleanUrl(CONFIG.ESP32_BASE_URL);

/* ---------- event terminal ---------- */
function log(msg, cls = "info") {
  if (state.logPaused) return;
  const term = $("term");
  const p = document.createElement("p");
  const t = document.createElement("span");
  t.className = "t"; t.textContent = `[${nowStr()}] `;
  const m = document.createElement("span");
  m.className = cls; m.textContent = msg;
  p.append(t, m);
  term.appendChild(p);
  while (term.children.length > 200) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;
}

/* ---------- landing -> dashboard ---------- */
function enterDashboard() {
  const land = $("landing");
  land.classList.add("is-leaving");
  $("app").hidden = false;
  document.body.classList.remove("is-landing");
  setTimeout(() => (land.hidden = true), 750);
  if (state.entered) { log("Dashboard opened.", "info"); return; }
  state.entered = true;
  state.missionStart = Date.now();
  log("System initialized. Rover: BEE.", "ok");
  log("Dashboard loaded.");
  log("Demo mode active. Simulated values are labelled.", "warn");
  log("Controller connection pending.", "warn");
  log("Camera connection unavailable.", "warn");
  startPolling();
}

/* ---------- return home (same page: shows the landing screen again) ---------- */
function returnHome() {
  stopAll();                                   // never leave the rover moving
  const land = $("landing");
  land.hidden = false;
  void land.offsetWidth;                       // restart the fade transition
  land.classList.remove("is-leaving");
  $("app").hidden = true;
  document.body.classList.add("is-landing");
  if (document.fullscreenElement) document.exitFullscreen();
  log("Returned to home screen.");
}

/* ---------- clock & mission timer ---------- */
function tickClock() {
  $("clock").textContent = nowStr();
  const s = Math.floor((Date.now() - state.missionStart) / 1000);
  $("msTimer").textContent = `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  if (state.camOk) $("camStamp").textContent = new Date().toLocaleString();
  else $("camStamp").textContent = new Date().toLocaleString() + " · no feed";
}

/* ---------- UI refresh ---------- */
function setText(id, v) { $(id).textContent = v; }
function updateStatusUI() {
  const hw = state.hardware;
  // connection badge
  const b = $("connBadge");
  if (!hw) { b.className = "badge badge--demo"; setText("connText", "DEMO"); }
  else if (state.linked) { b.className = "badge badge--on"; setText("connText", "ONLINE"); }
  else { b.className = "badge badge--off"; setText("connText", "OFFLINE"); }
  const wifi = $("wifi");
  wifi.dataset.level = hw && state.linked ? "4" : "0";
  wifi.setAttribute("aria-label", hw && state.linked ? "Wi-Fi: connected" : "Wi-Fi: no signal");

  setText("ovLink", !hw ? "Demo (no link)" : state.linked ? "Online" : "Offline");
  setText("ovLinkSrc", hw ? "hardware" : "demo");
  setText("ovMode", state.auto ? "Auto (demo)" : "Manual");
  setText("ovCam", state.camOk ? "Streaming" : "Disconnected");
  setText("msCam", state.camOk ? "Streaming" : "Disconnected");
  setText("msMove", MOVE_NAMES[state.moving]);
  const real = hw && state.linked;
  setText("msSens", real ? "Hardware" : hw ? "No data" : "Simulated");
  ["ovDistSrc", "ovObsSrc"].forEach((id) => { setText(id, real ? "hardware" : "simulated"); $(id).className = "src " + (real ? "real" : "sim"); });
  setText("usSrc", real ? "HARDWARE" : "SIMULATED");
  $("usSrc").className = "src " + (real ? "real" : "sim");

  // controls are disabled in hardware mode while the controller is unreachable
  const locked = hw && !state.linked;
  $("pad").classList.toggle("is-disabled", locked);
  setText("ctlNote", !hw ? "Demo mode: buttons update the UI only. No commands are sent."
    : state.linked ? "Hardware mode: commands go to the ESP32. Keep the rover on blocks for first tests."
    : "Hardware mode: controller disconnected. Controls disabled.");
}

function updateDistanceUI() {
  const d = state.distance;
  const has = typeof d === "number" && isFinite(d);
  setText("usVal", has ? d.toFixed(0) : "--");
  setText("ovDist", has ? d.toFixed(0) : "--");
  $("gaugeFill").style.width = has ? Math.min(100, (d / 200) * 100) + "%" : "0";
  $("gaugeMark").style.left = Math.min(100, (state.threshold / 200) * 100) + "%";
  $("gauge").setAttribute("aria-valuenow", has ? Math.round(d) : 0);
  const st = $("usStatus");
  let label = "NO DATA", cls = "status status--warn";
  if (has) {
    if (d <= state.threshold) { label = "OBSTACLE DETECTED"; cls = "status status--bad"; }
    else if (d <= state.threshold * 1.8) { label = "CAUTION"; cls = "status status--warn"; }
    else { label = "CLEAR"; cls = "status status--ok"; }
  }
  st.textContent = label; st.className = cls;
  const prev = state._obs;
  state._obs = label === "OBSTACLE DETECTED";
  setText("ovObs", label === "OBSTACLE DETECTED" ? "Obstacle" : label === "CAUTION" ? "Caution" : has ? "Clear" : "No data");
  if (state._obs && !prev) {
    log(`Obstacle detected at ${d.toFixed(0)} cm (${state.hardware ? "hardware" : "simulated"}).`, "err");
    if (state.auto && state.moving !== "S") sendMove("S", true); // demo-only reaction
  }
}

/* ---------- ESP32 communication ---------- */
/* fetch with a timeout so a dead board never freezes the UI */
async function fetchTimeout(url, ms = CONFIG.REQUEST_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

/* HARDWARE: GET <base>/cmd?m=F|B|L|R|S */
async function sendToDevice(cmd) {
  const base = cleanUrl(CONFIG.ESP32_BASE_URL);
  if (!base) throw new Error("Invalid ESP32_BASE_URL");
  const res = await fetchTimeout(`${base}${CONFIG.CMD_PATH}?m=${cmd}`);
  if (!res.ok) throw new Error("HTTP " + res.status);
}

/* Update UI, and only talk to the device when hardware mode is ON. */
async function sendMove(cmd, silent = false) {
  state.moving = cmd;
  setText("msLast", `${MOVE_NAMES[cmd]} (${cmd})`);
  updateStatusUI();
  if (!silent) log(cmd === "S" ? "Stop command sent." : `Movement command sent: ${MOVE_NAMES[cmd]}.`, cmd === "S" ? "info" : "ok");
  if (!state.hardware) return;                 // DEMO: never send anything
  try { await sendToDevice(cmd); state.failCount = 0; }
  catch (e) {
    log(`Command ${cmd} failed: ${e.name === "AbortError" ? "timeout" : e.message}`, "err");
    if (cmd === "S") setTimeout(() => sendToDevice("S").catch(() => {}), 150); // retry stop once
  }
}

/* HARDWARE: GET <base>/api/status -> {"distance_cm": number}  */
async function pollStatus() {
  if (!state.hardware) { simulateSensor(); return; }
  const base = cleanUrl(CONFIG.ESP32_BASE_URL);
  try {
    const res = await fetchTimeout(`${base}${CONFIG.STATUS_PATH}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const d = Number(data.distance_cm);
    if (!state.linked) log("Controller connected.", "ok");
    state.linked = true; state.failCount = 0;
    state.distance = isFinite(d) && d >= 0 ? d : null;
  } catch (e) {
    state.failCount++;
    if (state.linked || state.failCount === 1) log(`Controller unreachable (${e.name === "AbortError" ? "timeout" : e.message}).`, "err");
    state.linked = false; state.distance = null;
    stopAll("link lost");
  }
  updateStatusUI(); updateDistanceUI();
}

/* DEMO: fake distance that wanders and occasionally approaches an "obstacle" */
let simT = 0;
function simulateSensor() {
  simT += 0.12;
  state.distance = Math.max(4, 70 + Math.sin(simT) * 55 + Math.sin(simT * 2.7) * 15);
  updateStatusUI(); updateDistanceUI();
}
function startPolling() {
  clearInterval(state.pollTimer);
  pollStatus();
  state.pollTimer = setInterval(pollStatus, CONFIG.STATUS_POLL_MS);
}

/* ---------- movement: press-and-hold ---------- */
function pressMove(cmd) {
  if (state.hardware && !state.linked) return;
  if (cmd === "S") { stopAll("stop button"); return; }
  if (state.auto) { log("Switch to Manual to drive.", "warn"); return; }
  if (state.held === cmd) return;
  releaseMove(false);
  state.held = cmd;
  document.querySelector(`.pad__b[data-cmd="${cmd}"]`)?.classList.add("is-active");
  sendMove(cmd);
  // Repeat while held so a firmware safety timeout keeps the motors alive
  state.holdTimer = setInterval(() => { if (state.hardware) sendToDevice(cmd).catch(() => {}); }, CONFIG.HOLD_REPEAT_MS);
}
function releaseMove(sendStop = true) {
  clearInterval(state.holdTimer);
  document.querySelectorAll(".pad__b.is-active").forEach((b) => b.classList.remove("is-active"));
  if (state.held && sendStop) sendMove("S");
  state.held = null;
}
function stopAll(reason) {
  const wasMoving = state.moving !== "S" || state.held;
  releaseMove(false);
  if (wasMoving || reason === "emergency") sendMove("S", true);
  if (reason) log(reason === "emergency" ? "Emergency stop activated." : `Stopped (${reason}).`, reason === "emergency" ? "err" : "warn");
}

function bindControls() {
  document.querySelectorAll(".pad__b").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); pressMove(cmd); });
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => btn.addEventListener(ev, () => { if (cmd !== "S") releaseMove(true); }));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });
  $("estopBtn").addEventListener("click", () => stopAll("emergency"));

  const keymap = { ArrowUp: "F", w: "F", ArrowDown: "B", s: "B", ArrowLeft: "L", a: "L", ArrowRight: "R", d: "R" };
  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, dialog")) return;
    if (e.code === "Space") { e.preventDefault(); stopAll("emergency"); return; }
    const cmd = keymap[e.key] || keymap[e.key.toLowerCase?.()];
    if (cmd && !e.repeat) { e.preventDefault(); pressMove(cmd); }
  });
  window.addEventListener("keyup", (e) => {
    const cmd = keymap[e.key] || keymap[e.key.toLowerCase?.()];
    if (cmd && state.held === cmd) releaseMove(true);
  });
  // Safety: always try to stop when focus is lost
  window.addEventListener("blur", () => { if (state.held) { releaseMove(true); log("Window lost focus: stop sent.", "warn"); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden && state.held) releaseMove(true); });
  window.addEventListener("pagehide", () => { if (state.hardware) sendToDevice("S").catch(() => {}); });
}

/* ---------- mode switching ---------- */
function setHardware(on) {
  if (on && !hardwareConfigured()) {
    log("Hardware mode needs a valid ESP32 URL. Open Settings.", "err");
    $("settings").showModal(); return;
  }
  stopAll();
  state.hardware = on; state.linked = false; state.failCount = 0; state.distance = null;
  $("modeDemo").classList.toggle("is-on", !on); $("modeHw").classList.toggle("is-on", on);
  $("modeDemo").setAttribute("aria-pressed", String(!on)); $("modeHw").setAttribute("aria-pressed", String(on));
  log(on ? "Hardware mode selected. Waiting for controller…" : "Demo mode active. No commands will be sent.", on ? "warn" : "info");
  updateStatusUI(); startPolling(); setupCamera();
}
function setAuto(on) {
  state.auto = on; stopAll();
  $("ctlAuto").classList.toggle("is-on", on); $("ctlManual").classList.toggle("is-on", !on);
  log(on ? "Auto mode (DEMO only): stops when an obstacle is seen. Not real autonomy." : "Manual mode.", on ? "warn" : "info");
  updateStatusUI();
}

/* ---------- camera ---------- */
/* HARDWARE: ESP32-CAM MJPEG stream shown in an <img>. Only used in hardware mode. */
function setupCamera() {
  const img = $("camImg"), ph = $("camPlaceholder");
  const url = cleanUrl(CONFIG.CAMERA_STREAM_URL);
  state.camOk = false;
  img.hidden = true; ph.hidden = false; img.removeAttribute("src");
  $("camBadge").className = "badge badge--off"; $("camBadge").lastChild.textContent = "NO SIGNAL";
  if (!state.hardware) { setText("camMsg", "Camera not connected (demo mode)"); updateStatusUI(); return; }
  if (!url) { setText("camMsg", "No camera stream URL set"); log("Camera connection unavailable: set CAMERA_STREAM_URL.", "warn"); updateStatusUI(); return; }
  setText("camMsg", "Connecting to camera…");
  $("camBadge").className = "badge badge--demo"; $("camBadge").lastChild.textContent = "CONNECTING";
  img.onload = () => {
    state.camOk = true; img.hidden = false; ph.hidden = true;
    $("camBadge").className = "badge badge--on"; $("camBadge").lastChild.textContent = "LIVE";
    log("Camera stream connected.", "ok"); updateStatusUI();
  };
  img.onerror = () => {
    state.camOk = false; img.hidden = true; ph.hidden = false;
    setText("camMsg", "Camera stream failed to load");
    $("camBadge").className = "badge badge--off"; $("camBadge").lastChild.textContent = "NO SIGNAL";
    log("Camera stream failed. Check the URL and that the ESP32-CAM is on the same Wi-Fi.", "err"); updateStatusUI();
  };
  img.src = url;
}

/* Capture a frame: try the capture URL first, otherwise draw the stream frame to a canvas. */
async function capturePhoto() {
  if (!state.camOk) { log("Capture failed: no camera feed available.", "err"); alert("No camera feed. Connect the ESP32-CAM in Hardware mode first."); return; }
  try {
    let dataUrl;
    const cap = cleanUrl(CONFIG.CAMERA_CAPTURE_URL);
    if (cap) {
      const res = await fetchTimeout(cap, 5000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      dataUrl = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    } else {
      const img = $("camImg"), c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      dataUrl = c.toDataURL("image/jpeg", 0.92);   // fails if the camera blocks CORS
    }
    addSnapshot(dataUrl);
  } catch (e) {
    log("Capture failed: " + e.message + " (camera may block cross-origin access).", "err");
    alert("Could not capture a frame. Set CAMERA_CAPTURE_URL, and make sure the camera firmware allows cross-origin requests.");
  }
}
function addSnapshot(dataUrl) {
  const g = $("gallery");
  g.querySelector(".empty")?.remove();
  const img = document.createElement("img");
  img.src = dataUrl; img.alt = "Snapshot"; img.title = "Click to download";
  img.addEventListener("click", () => { const a = document.createElement("a"); a.href = dataUrl; a.download = `roborescue-${Date.now()}.jpg`; a.click(); });
  g.prepend(img);
  const a = document.createElement("a"); a.href = dataUrl; a.download = `roborescue-${Date.now()}.jpg`; a.click(); // saved locally only
  log("Snapshot captured and downloaded.", "ok");
}

/* ---------- settings dialog ---------- */
function openSettings() {
  $("setBase").value = CONFIG.ESP32_BASE_URL; $("setStream").value = CONFIG.CAMERA_STREAM_URL; $("setCap").value = CONFIG.CAMERA_CAPTURE_URL;
  $("setErr").textContent = ""; $("settings").showModal();
}
function applySettings() {
  const b = cleanUrl($("setBase").value), s = cleanUrl($("setStream").value), c = cleanUrl($("setCap").value);
  if (b === null || s === null || c === null) { $("setErr").textContent = "Each address must start with http:// or https:// and be a valid URL."; return; }
  CONFIG.ESP32_BASE_URL = b; CONFIG.CAMERA_STREAM_URL = s; CONFIG.CAMERA_CAPTURE_URL = c;
  saveSettings(); $("settings").close(); log("Settings saved.", "ok");
  if (state.hardware) { state.linked = false; startPolling(); setupCamera(); }
}

/* ---------- init ---------- */
function init() {
  loadSettings();
  $("startBtn").addEventListener("click", enterDashboard);
  $("homeBtn").addEventListener("click", returnHome);
  $("settingsBtn").addEventListener("click", openSettings);
  $("setSave").addEventListener("click", applySettings);
  $("modeDemo").addEventListener("click", () => setHardware(false));
  $("modeHw").addEventListener("click", () => setHardware(true));
  $("ctlManual").addEventListener("click", () => setAuto(false));
  $("ctlAuto").addEventListener("click", () => setAuto(true));
  $("capBtn").addEventListener("click", capturePhoto);
  $("fsBtn").addEventListener("click", () => { const b = $("camBox"); document.fullscreenElement ? document.exitFullscreen() : b.requestFullscreen?.(); });
  $("thr").addEventListener("change", (e) => {
    const v = Math.min(150, Math.max(5, Number(e.target.value) || 20));
    e.target.value = v; state.threshold = v; updateDistanceUI(); log(`Obstacle threshold set to ${v} cm.`);
  });
  $("logClear").addEventListener("click", () => { $("term").textContent = ""; });
  $("logPause").addEventListener("click", (e) => {
    state.logPaused = !state.logPaused; e.target.textContent = state.logPaused ? "Resume" : "Pause";
  });
  bindControls();
  state.hardware = false;               // always start safe, in demo mode
  setupCamera(); updateStatusUI(); updateDistanceUI();
  tickClock(); setInterval(tickClock, 1000);
}
init();
