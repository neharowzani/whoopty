const map = L.map("map", { zoomControl: false, attributionControl: false });
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.control.attribution({ prefix: false }).addAttribution("&copy; OpenStreetMap contributors").addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 21, maxNativeZoom: 19 }).addTo(map);

const els = {
  status: document.getElementById("status"),
  card: document.getElementById("card"),
  gemma: document.getElementById("gemma"),
  gemmaLog: document.getElementById("gemma-log"),
  gemmaModel: document.getElementById("gemma-model"),
  replay: document.getElementById("replay"),
  live: document.getElementById("live"),
};

const CHASE = "#FFB020";

let chase = null;     // cameras, events, suspect: saved, or filling in while Gemma answers
let steps = [];       // crime first, then each camera where Gemma found the suspect
let revealed = 0;     // how many of those the chase has shown (only once the clip reaches that moment)
let finished = false;
let live = false;     // Gemma is still answering
let markers = {};
let path = null;
let source = null;
let run = 0;          // bumps on every new run, so an older run's loops stop
let video = null;     // the clip on screen
let onScreen = null;  // which camera it is

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const camera = (id) => chase.cameras.find((c) => c.id === id);
const escape = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const frame = () => new Promise((r) => setTimeout(r, 50));

function setStatus(text, alert = false) {
  els.status.textContent = text;
  els.status.classList.toggle("is-alert", alert);
}

function camIcon(cam, state = "") {
  const label = state.includes("is-alert") ? steps[0].type : cam.name;
  return L.divIcon({
    className: "cam-icon",
    html: `<div class="cam ${state}"><div class="cam-dot"></div><span class="cam-label">${label}</span></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// ---------- the card on the right ----------

function buildCard() {
  onScreen = null;
  video = null;
  els.card.innerHTML = `
    <section class="feed is-watching">
      <header class="feed-head">
        <span class="feed-dot"></span>
        <strong id="card-title">Watching</strong>
        <span id="card-sub" class="feed-cam"></span>
      </header>
      <p id="card-suspect" class="feed-suspect" hidden></p>
      <div id="card-video"></div>
      <div class="feed-caption">
        <button class="feed-nav" data-dir="-1" disabled aria-label="Previous camera">‹</button>
        <span id="card-caption" class="feed-caption-text"></span>
        <button class="feed-nav" data-dir="1" disabled aria-label="Next camera">›</button>
      </div>
      <ol id="card-steps" class="feed-steps"></ol>
    </section>`;
  els.card.querySelectorAll(".feed-nav").forEach((b) => (b.onclick = () => {
    const i = steps.findIndex((s) => s.camera === onScreen) + Number(b.dataset.dir);
    if (steps[i]) rewatch(i);
  }));
}

function setHead(title, sub) {
  els.card.querySelector("#card-title").textContent = title;
  els.card.querySelector("#card-sub").textContent = sub;
}

function setCaption(text) {
  els.card.querySelector("#card-caption").textContent = text;
}

function showClip(cam, { loop = false, from = 0 } = {}) {
  onScreen = cam.id;
  els.card.querySelector("#card-video").innerHTML = `<video class="feed-video" src="${cam.video}#t=${from}" autoplay muted playsinline ${loop ? "loop" : ""}></video>`;
  video = els.card.querySelector("video");
  video.started = performance.now() - from * 1000;
  return video;
}

// Where the clip is, in seconds. If the browser blocks autoplay, a clock stands in for it.
function clipTime(v) {
  if (v.currentTime > 0 || !v.paused) return v.currentTime;
  return (performance.now() - v.started) / 1000;
}

function renderSteps() {
  const box = els.card.querySelector("#card-steps");
  box.innerHTML = steps.slice(0, revealed).map((s, i) => `
    <li><button class="${s.camera === onScreen ? "now" : ""}" data-go="${i}" ${finished ? "" : "disabled"}>${i === 0 ? "Crime" : `Cam ${i + 1}`} ${clock(s.time)}</button></li>`).join("");
  box.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => rewatch(Number(b.dataset.go))));
  const at = steps.findIndex((s) => s.camera === onScreen);
  const [prev, next] = els.card.querySelectorAll(".feed-nav");
  prev.disabled = !finished || at <= 0;
  next.disabled = !finished || at < 0 || at >= revealed - 1;
}

function rewatch(i) {
  const s = steps[i];
  showClip(camera(s.camera));
  setCaption(`${camera(s.camera).name} · seen at ${clock(s.time)}`);
  renderSteps();
}

// ---------- the chase ----------

function setup(cameras) {
  run++;
  chase = { cameras, events: [], suspect: null };
  steps = [];
  revealed = 0;
  finished = false;
  Object.values(markers).forEach((m) => m.remove());
  markers = {};
  path?.remove();
  path = L.polyline([], { color: CHASE, weight: 5, lineCap: "round" }).addTo(map);
  for (const cam of cameras) markers[cam.id] = L.marker([cam.lat, cam.lng], { icon: camIcon(cam) }).addTo(map);
  // The cameras are ~20 m apart, so zoom in close enough to separate the pins.
  map.invalidateSize();
  map.setView(L.latLngBounds(cameras.map((c) => [c.lat, c.lng])).getCenter(), 20);
  buildCard();
}

// Before Play: camera 1 sits paused on its first frame, with a play button over it.
function ready() {
  setStatus(`${chase.cameras.length} cameras ready`);
  setHead("Ready", `${chase.cameras.length} cameras`);
  setCaption("Press play to start Gemma 4");
  const cam = chase.cameras[0];
  onScreen = cam.id;
  els.card.querySelector("#card-video").innerHTML = `
    <video class="feed-video" src="${cam.video}#t=0.1" muted playsinline preload="metadata"></video>
    <button class="play-overlay" aria-label="Play">▶</button>`;
  els.card.querySelector(".play-overlay").onclick = goLive;
}

// Waits until step i is known and its clip reaches the moment Gemma flagged. Returns false if there is none.
// Gemma watches in the background; nothing plays until it calls something.
function waiting() {
  onScreen = null;
  video = null;
  setHead("Watching", `${chase.cameras.length} cameras`);
  setCaption("");
  setStatus(`Gemma 4 is watching ${chase.cameras.length} cameras…`);
  els.card.querySelector("#card-video").innerHTML = `
    <div class="card-waiting"><span class="feeds-calm-dot"></span>Gemma 4 is watching ${chase.cameras.length} cameras. Nothing yet.</div>`;
}

// Waits until Gemma has an answer for step i. Returns false if there won't be one.
async function answerFor(i, id) {
  let asked = false;
  while (id === run && !steps[i]) {
    const answered = new Set(chase.events.map((e) => e.camera));
    if (!live || (i > 0 && chase.cameras.every((c) => answered.has(c.id)))) return false;
    if (i > 0 && !asked) setStatus("Looking for the suspect on the next cameras…", true);
    asked = true;
    await frame();
  }
  return id === run;
}

// The clip just reached the moment Gemma flagged: the crime is called, or the suspect's path lights up.
function detect(i) {
  const step = steps[i];
  const cam = camera(step.camera);
  revealed = i + 1;
  els.card.querySelector(".feed").classList.remove("is-watching");
  setHead(steps[0].type, i === 0 ? "Crime camera" : `Camera ${i + 1}`);
  const suspect = els.card.querySelector("#card-suspect");
  suspect.textContent = `Suspect: ${chase.suspect}`;
  suspect.hidden = false;
  setCaption(`${cam.name} · seen at ${clock(step.time)}`);
  markers[cam.id].setIcon(camIcon(cam, i === 0 ? "is-alert is-arrive" : "is-chase is-arrive"));
  const last = path.getLatLngs().at(-1);
  path.addLatLng([cam.lat, cam.lng]);
  if (last) {
    const flash = L.polyline([last, [cam.lat, cam.lng]], { color: CHASE, weight: 14, opacity: 0.9, lineCap: "round", className: "path-flash" }).addTo(map);
    setTimeout(() => flash.remove(), 1400);
  }
  setStatus(i === 0 ? `${step.type[0].toUpperCase()}${step.type.slice(1)} at ${cam.name}. Following suspect…` : `Suspect seen at ${cam.name}, ${clock(step.time)}`, true);
  renderSteps();
}

async function follow() {
  const id = run;
  waiting();
  for (let i = 0; ; i++) {
    if (!(await answerFor(i, id))) break;
    const step = steps[i];
    const cam = camera(step.camera);
    if (i === 0) {
      // The crime is called: pull it up, starting just before the moment Gemma flagged.
      detect(0);
      showClip(cam, { from: Math.max(step.offset_s - 2, 0) });
    } else {
      // The next camera, from just before the suspect appears; his path lights up when he's in frame.
      showClip(cam, { from: Math.max(step.offset_s - 1.5, 0) });
      while (id === run && clipTime(video) < step.offset_s) await frame();
      if (id !== run) return;
      detect(i);
    }
    const length = cam.duration || 5;
    while (id === run && clipTime(video) < length) await frame();
    if (id !== run) return;
  }
  if (!steps.length) {
    if (id === run) setStatus("No crime found");
    return;
  }
  if (id === run) finish();
}

function finish() {
  if (finished) return;
  finished = true;
  const last = steps.at(-1);
  setStatus(`Last seen at ${camera(last.camera).name}, ${clock(last.time)}`, true);
  renderSteps();
}

function stopLive() {
  source?.close();
  source = null;
  live = false;
  els.live.disabled = false;
}

async function loadSaved() {
  const data = await (await fetch("data/chase.json")).json();
  setup(data.cameras);
  return data;
}

async function replay() {
  stopLive();
  els.gemma.hidden = true;
  const data = await loadSaved();
  Object.assign(chase, data);
  const saved = data.events.filter((e) => e.kind !== "clear");
  live = true; // hold the saved answers back briefly, as if Gemma were still watching
  follow();
  const id = run;
  setTimeout(() => {
    if (id !== run) return;
    steps = saved;
    live = false;
  }, 2500);
}

// ---------- live: Gemma's steps stream in, and the chase follows its answers ----------

function task(cameraId) {
  return els.gemmaLog.querySelector(`[data-cam="${cameraId}"]`);
}

function addTask(step) {
  const cam = camera(step.camera);
  els.gemmaModel.textContent = step.model;
  els.gemmaLog.insertAdjacentHTML("beforeend", `
    <li class="gemma-task is-running" data-cam="${step.camera}">
      <div class="gemma-q">
        <span class="gemma-spin"></span>
        <span>${cam.name} · ${step.frames} frames · ${step.question}</span>
      </div>
      <div class="gemma-think"></div>
      <div class="gemma-a"></div>
    </li>`);
  els.gemmaLog.scrollTop = els.gemmaLog.scrollHeight;
}

function addText(step) {
  const box = task(step.camera)?.querySelector(step.thought ? ".gemma-think" : ".gemma-a");
  if (!box) return;
  box.textContent += step.text;
  box.scrollTop = box.scrollHeight;
  els.gemmaLog.scrollTop = els.gemmaLog.scrollHeight;
}

function closeTask(cameraId, kind, text) {
  const t = task(cameraId);
  if (!t) return;
  t.classList.remove("is-running");
  t.classList.add(`is-${kind}`);
  t.querySelector(".gemma-a").textContent = text;
}

function onStep(step) {
  if (step.stage === "cameras") {
    // Already set up from the same cameras; just keep them current.
    chase.cameras = step.cameras;
  } else if (step.stage === "asking") {
    addTask(step);
  } else if (step.stage === "token") {
    addText(step);
  } else if (step.stage === "answer") {
    const e = step.event;
    chase.events.push(e);
    const cam = camera(e.camera);
    if (e.kind === "clear") {
      closeTask(e.camera, "clear", `No ${e.camera === chase.cameras[0].id ? "crime" : "match"} at ${cam.name}.`);
    } else if (e.kind === "crime") {
      chase.suspect = step.suspect;
      closeTask(e.camera, "crime", `${e.type}: ${e.text} Suspect: ${step.suspect}.`);
      steps.push(e);
    } else {
      closeTask(e.camera, "match", `Suspect here at ${clock(e.time)}. ${e.text}`);
      // Cameras answer in any order; the chase follows them in time order.
      steps.push(e);
      steps.sort((a, b) => a.time.localeCompare(b.time));
    }
  } else if (step.stage === "done") {
    stopLive();
    els.gemma.querySelector(".gemma-sub").textContent = "done";
  } else if (step.stage === "error") {
    stopLive();
    els.gemmaLog.insertAdjacentHTML("beforeend", `<li class="gemma-task is-crime"><div class="gemma-a">Error: ${escape(step.message)}</div></li>`);
    setStatus(`Live run failed: ${step.message}`, true);
  }
}

async function goLive() {
  stopLive();
  live = true;
  els.live.disabled = true;
  els.gemma.hidden = false;
  els.gemma.querySelector(".gemma-sub").textContent = "thinking live";
  els.gemmaLog.innerHTML = "";
  await loadSaved(); // only for the camera positions and clips; every answer comes from Gemma now
  live = true;
  follow();
  source = new EventSource("/api/live");
  source.onmessage = (msg) => onStep(JSON.parse(msg.data));
  source.onerror = () => {
    if (!live) return;
    stopLive();
    setStatus("Lost the connection to the server", true);
  };
}

els.replay.onclick = replay;
els.live.onclick = goLive;
loadSaved().then(ready).catch(() => setStatus("No cameras yet. Run pipeline.py once."));
