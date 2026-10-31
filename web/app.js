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

const PRIORITY = { high: "High priority", medium: "Medium priority", low: "Low priority" };
const CHASE = "#FFB020";
// While the next camera hasn't answered yet, the suspect's dot waits just short of it.
const WAIT_AT = 0.92;

let chase = null;     // cameras, events, suspect, dispatch: saved, or filling in during a live run
let steps = [];       // crime first, then each camera that saw the suspect
let revealed = 0;     // how many steps the chase has reached
let shown = 0;        // which step's clip is on screen
let decided = null;
let finished = false;
let live = false;     // Gemma is still answering
let markers = {};
let path = null;      // lit: cameras where Gemma found the suspect
let ahead = null;     // the stretch the dot is crossing (never drawn)
let tracker = null;   // where the suspect is now
let stepStart = 0;
let timer = null;
let source = null;
let run = 0;

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const camera = (id) => chase.cameras.find((c) => c.id === id);
const escape = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

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

function setup(cameras) {
  chase = { cameras, events: [], suspect: null, dispatch: null };
  steps = [];
  Object.values(markers).forEach((m) => m.remove());
  markers = {};
  [path, ahead, tracker].forEach((layer) => layer?.remove());
  path = L.polyline([], { color: CHASE, weight: 5, lineCap: "round" }).addTo(map);
  // Not drawn: the path only lights up once Gemma finds the suspect at the next camera.
  ahead = L.polyline([], { opacity: 0 });
  tracker = L.circleMarker([0, 0], { radius: 7, color: "#E6EDF2", weight: 2, fillColor: CHASE, fillOpacity: 1, interactive: false });
  for (const cam of cameras) markers[cam.id] = L.marker([cam.lat, cam.lng], { icon: camIcon(cam) }).addTo(map);
  // The cameras are ~20 m apart, so zoom in close enough to separate the pins.
  map.invalidateSize();
  map.setView(L.latLngBounds(cameras.map((c) => [c.lat, c.lng])).getCenter(), 20);
  reset();
}

function reset() {
  clearInterval(timer);
  revealed = 0;
  shown = 0;
  decided = null;
  finished = false;
  path.setLatLngs([]);
  ahead.setLatLngs([]);
  tracker.remove();
  for (const cam of chase.cameras) markers[cam.id].setIcon(camIcon(cam));
  setStatus(`Watching ${chase.cameras.length} cameras`);
  watching(`No open crimes. All ${chase.cameras.length} cameras are watching.`);
}

// Before a crime is found: one camera's clip at a time. Cycles through the cameras unless `only` is set.
function watching(note, i = 0, only = null) {
  const cam = only ? camera(only) : chase.cameras[i % chase.cameras.length];
  els.card.innerHTML = `
    <div class="feeds-calm"><span class="feeds-calm-dot"></span><span>${note}</span></div>
    <figure class="watch-tile">
      <video src="${cam.video}" autoplay muted playsinline ${only ? "loop" : ""}></video>
      <figcaption>${cam.name}</figcaption>
    </figure>`;
  const id = run;
  els.card.querySelector("video").onended = () => { if (id === run && revealed === 0 && !only) watching(note, i + 1); };
}

// Where the suspect's dot heads next: the next camera that saw them, or during a live run the next
// camera Gemma hasn't answered for yet.
function nextCamera() {
  if (steps[revealed]) return camera(steps[revealed].camera);
  if (!live) return null;
  const answered = new Set(chase.events.map((e) => e.camera));
  return chase.cameras.find((c) => !answered.has(c.id)) ?? null;
}

// Moves the chase on a clock as long as each clip, so the map runs even if a browser blocks autoplay.
function tick() {
  const here = camera(steps[revealed - 1].camera);
  const length = (here.duration || 5) * 1000;
  const raw = (performance.now() - stepStart) / length;
  const next = nextCamera();
  if (next) {
    const share = Math.min(raw, steps[revealed] ? 1 : WAIT_AT);
    ahead.setLatLngs([[here.lat, here.lng], [next.lat, next.lng]]);
    tracker.setLatLng([here.lat + (next.lat - here.lat) * share, here.lng + (next.lng - here.lng) * share]);
  } else {
    ahead.setLatLngs([]);
  }
  if (raw < 1) return;
  if (steps[revealed]) reveal();
  else if (!live) finish();
}

// The suspect reaches the next camera: that stretch of the path lights up, and the card switches to its clip.
function reveal() {
  const step = steps[revealed];
  const cam = camera(step.camera);
  revealed++;
  markers[cam.id].setIcon(camIcon(cam, revealed === 1 ? "is-alert is-arrive" : "is-chase is-arrive"));
  const last = path.getLatLngs().at(-1);
  path.addLatLng([cam.lat, cam.lng]);
  if (last) {
    const flash = L.polyline([last, [cam.lat, cam.lng]], { color: CHASE, weight: 14, opacity: 0.9, lineCap: "round", className: "path-flash" }).addTo(map);
    setTimeout(() => flash.remove(), 1400);
  }
  tracker.setLatLng([cam.lat, cam.lng]).addTo(map);
  ahead.setLatLngs([]);
  setStatus(revealed === 1 ? `${step.type} at ${cam.name}. Following suspect…` : `Suspect seen at ${cam.name}, ${clock(step.time)}`, true);
  show(revealed - 1);
  stepStart = performance.now();
  clearInterval(timer);
  timer = setInterval(tick, 50);
}

function show(i) {
  shown = i;
  render();
}

function render() {
  const step = steps[shown];
  const cam = camera(step.camera);
  const report = finished ? chase.dispatch : null;
  const reportOpen = els.card.querySelector(".dispatch-report:not([hidden])") !== null || (report && !decided && !els.card.dataset.closed);

  els.card.innerHTML = `
    <section class="feed">
      <header class="feed-head">
        <span class="feed-dot"></span>
        <strong>${steps[0].type}</strong>
        <span class="feed-cam">${revealed === 1 ? "Crime camera" : `Camera ${revealed}`}</span>
        <span class="feed-spacer"></span>
        <button class="dispatch-btn${report ? " is-ready" : ""}${decided ? " is-decided" : ""}" ${report ? "" : "disabled"}>Dispatch report</button>
      </header>
      ${report ? `
      <div class="dispatch-report" ${reportOpen ? "" : "hidden"}>
        <header>
          <span class="dispatch-priority is-${report.priority}">${PRIORITY[report.priority] ?? report.priority}</span>
          <span class="dispatch-decide">
            ${decided ? `<span class="dispatch-decided">${decided}</span>` : `
              <button class="dispatch-confirm">Confirm</button>
              <button class="dispatch-dismiss">Dismiss</button>`}
            <button class="dispatch-close" aria-label="Close">×</button>
          </span>
        </header>
        <p class="dispatch-action">${escape(report.recommendation)}</p>
        <p class="dispatch-procedure">Procedure: ${escape(report.procedure)}</p>
        <p class="dispatch-suspect">Suspect: ${escape(chase.suspect)}</p>
      </div>` : ""}
      <video class="feed-video" src="${cam.video}" autoplay muted playsinline></video>
      <div class="feed-caption">
        <button class="feed-nav" data-go="${shown - 1}" ${shown <= 0 ? "disabled" : ""} aria-label="Previous camera">‹</button>
        <span class="feed-caption-text">${cam.name} · seen at ${clock(step.time)}</span>
        <button class="feed-nav" data-go="${shown + 1}" ${shown >= revealed - 1 ? "disabled" : ""} aria-label="Next camera">›</button>
      </div>
      <ol class="feed-steps">
        ${steps.slice(0, revealed).map((s, i) => `
          <li><button class="${i === shown ? "now" : ""}" data-go="${i}">${i === 0 ? "Crime" : `Cam ${i + 1}`} ${clock(s.time)}</button></li>`).join("")}
      </ol>
    </section>`;

  els.card.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => show(Number(b.dataset.go))));
  els.card.querySelector(".dispatch-btn").onclick = () => {
    const box = els.card.querySelector(".dispatch-report");
    if (!box) return;
    box.hidden = !box.hidden;
    els.card.dataset.closed = box.hidden ? "1" : "";
  };
  els.card.querySelector(".dispatch-close")?.addEventListener("click", () => {
    els.card.querySelector(".dispatch-report").hidden = true;
    els.card.dataset.closed = "1";
  });
  els.card.querySelector(".dispatch-confirm")?.addEventListener("click", () => decide("Confirmed"));
  els.card.querySelector(".dispatch-dismiss")?.addEventListener("click", () => decide("Dismissed"));
}

// The chase reached its last camera and Gemma has written the dispatch report.
function finish() {
  if (finished || !chase.dispatch) return;
  clearInterval(timer);
  finished = true;
  ahead.setLatLngs([]);
  const last = steps.at(-1);
  setStatus(`Last seen at ${camera(last.camera).name}, ${clock(last.time)}. Needs your decision`, true);
  const video = els.card.querySelector("video");
  const t = video?.currentTime ?? 0;
  delete els.card.dataset.closed;
  render();
  // Keep the clip where it was instead of restarting it.
  const fresh = els.card.querySelector("video");
  fresh.currentTime = t;
  if (video?.ended) fresh.pause();
}

function decide(word) {
  decided = word;
  setStatus(`${word}. Last seen at ${camera(steps.at(-1).camera).name}`);
  render();
}

function stopLive() {
  source?.close();
  source = null;
  live = false;
  els.live.disabled = false;
}

function replay() {
  stopLive();
  run++;
  els.gemma.hidden = true;
  delete els.card.dataset.closed;
  fetch("data/chase.json")
    .then((r) => r.json())
    .then((data) => {
      setup(data.cameras);
      Object.assign(chase, data);
      steps = data.events.filter((e) => e.kind !== "clear");
      if (!steps.length) return setStatus("No crime found");
      const id = run;
      setTimeout(() => { if (id === run) reveal(); }, 800);
    })
    .catch(() => setStatus("No saved run yet. Click Run Gemma live."));
}

// ---------- live: Gemma's steps stream in, and the chase follows its answers ----------

function addTask(step) {
  const cam = step.camera ? camera(step.camera) : null;
  els.gemmaModel.textContent = step.model;
  els.gemmaLog.querySelector(".is-running")?.classList.remove("is-running");
  els.gemmaLog.insertAdjacentHTML("beforeend", `
    <li class="gemma-task is-running">
      <div class="gemma-q">
        <span class="gemma-spin"></span>
        <span>${cam ? `${cam.name} · ${step.frames} frames` : "Dispatch"} · ${step.question}</span>
      </div>
      <div class="gemma-think"></div>
      <div class="gemma-a"></div>
    </li>`);
  els.gemmaLog.scrollTop = els.gemmaLog.scrollHeight;
}

function addText(step) {
  const task = els.gemmaLog.querySelector(".is-running");
  if (!task) return;
  const box = task.querySelector(step.thought ? ".gemma-think" : ".gemma-a");
  box.textContent += step.text;
  box.scrollTop = box.scrollHeight;
  els.gemmaLog.scrollTop = els.gemmaLog.scrollHeight;
}

function closeTask(kind, text) {
  const task = els.gemmaLog.querySelector(".is-running");
  if (!task) return;
  task.classList.remove("is-running");
  task.classList.add(`is-${kind}`);
  task.querySelector(".gemma-a").textContent = text;
}

function onStep(step) {
  if (step.stage === "cameras") {
    setup(step.cameras);
    setStatus("Gemma 4 is watching the cameras…");
  } else if (step.stage === "asking") {
    addTask(step);
    if (step.camera) {
      document.querySelectorAll(".cam.is-checking").forEach((el) => el.classList.remove("is-checking"));
      markers[step.camera].getElement()?.querySelector(".cam")?.classList.add("is-checking");
      if (!revealed) watching(`Gemma 4 is checking ${camera(step.camera).name}…`, 0, step.camera);
    }
  } else if (step.stage === "token") {
    addText(step);
  } else if (step.stage === "answer") {
    const e = step.event;
    chase.events.push(e);
    const cam = camera(e.camera);
    markers[cam.id].getElement()?.querySelector(".cam")?.classList.remove("is-checking");
    if (e.kind === "clear") {
      closeTask("clear", `No ${steps.length ? "match" : "crime"} at ${cam.name}.`);
      markers[cam.id].setIcon(camIcon(cam, steps.some((s) => s.camera === cam.id) ? "is-chase" : ""));
      return;
    }
    if (e.kind === "crime") {
      chase.suspect = step.suspect;
      closeTask("crime", `${e.type}: ${e.text} Suspect: ${step.suspect}.`);
    } else {
      closeTask("match", `Suspect here at ${clock(e.time)}. ${e.text}`);
    }
    steps.push(e);
    if (e.kind === "crime") reveal();
  } else if (step.stage === "dispatch") {
    chase.dispatch = step.dispatch;
    closeTask("match", `${PRIORITY[step.dispatch.priority] ?? step.dispatch.priority}. ${step.dispatch.recommendation}`);
  } else if (step.stage === "done") {
    stopLive();
    els.gemma.querySelector(".gemma-sub").textContent = "done";
    if (!steps.length) setStatus("Gemma found no crime");
    // If the chase already reached its last camera, it was only waiting on the dispatch report.
    else if (revealed === steps.length && performance.now() - stepStart >= (camera(steps.at(-1).camera).duration || 5) * 1000) finish();
  } else if (step.stage === "error") {
    stopLive();
    closeTask("clear", `Error: ${step.message}`);
    setStatus(`Live run failed: ${step.message}`, true);
  }
}

function goLive() {
  stopLive();
  run++;
  live = true;
  els.live.disabled = true;
  els.gemma.hidden = false;
  els.gemma.querySelector(".gemma-sub").textContent = "thinking live";
  els.gemmaLog.innerHTML = "";
  delete els.card.dataset.closed;
  setStatus("Starting Gemma 4…");
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
replay();
