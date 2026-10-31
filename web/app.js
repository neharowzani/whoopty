const map = L.map("map", { zoomControl: false, attributionControl: false });
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.control.attribution({ prefix: false }).addAttribution("&copy; OpenStreetMap contributors").addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 21, maxNativeZoom: 19 }).addTo(map);

const els = {
  status: document.getElementById("status"),
  feeds: document.getElementById("feeds"),
  replay: document.getElementById("replay"),
  live: document.getElementById("live"),
};

const PRIORITY = { high: "High priority", medium: "Medium priority", low: "Low priority" };

let chase = null;   // the saved Gemma run
let steps = [];     // crime first, then each camera that saw the suspect
let revealed = 0;   // how many steps have played so far
let shown = 0;      // which step's video is on screen
let decided = null;
let markers = {};
let path = null;      // solid: cameras that already saw the suspect
let ahead = null;     // faint: from the newest camera to the next one
let fill = null;      // fills along `ahead` while the newest clip plays
let tracker = null;   // where the suspect is now
let stepStart = 0;    // when the newest camera's clip started
let timer = null;
let run = 0;

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const camera = (id) => chase.cameras.find((c) => c.id === id);

function setStatus(text, alert = false) {
  els.status.textContent = text;
  els.status.classList.toggle("is-alert", alert);
}

function camIcon(cam, state = "") {
  const label = state === "is-alert" ? steps[0].type : cam.name;
  return L.divIcon({
    className: "cam-icon",
    html: `<div class="cam ${state}"><div class="cam-dot"></div><span class="cam-label">${label}</span></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function load(data) {
  chase = data;
  steps = data.events.filter((e) => e.kind !== "clear");
  Object.values(markers).forEach((m) => m.remove());
  markers = {};
  [path, ahead, fill, tracker].forEach((layer) => layer?.remove());
  path = L.polyline([], { color: "#FFB020", weight: 4, lineCap: "round" }).addTo(map);
  ahead = L.polyline([], { color: "#FFB020", weight: 4, opacity: 0.25, lineCap: "round" }).addTo(map);
  fill = L.polyline([], { color: "#FFB020", weight: 5, lineCap: "round" }).addTo(map);
  tracker = L.circleMarker([0, 0], { radius: 7, color: "#E6EDF2", weight: 2, fillColor: "#FFB020", fillOpacity: 1, interactive: false });
  for (const cam of data.cameras) markers[cam.id] = L.marker([cam.lat, cam.lng], { icon: camIcon(cam) }).addTo(map);
  // The cameras are ~20 m apart, so zoom in close enough to separate the pins.
  map.invalidateSize();
  map.setView(L.latLngBounds(data.cameras.map((c) => [c.lat, c.lng])).getCenter(), 20);
  reset();
}

function reset() {
  clearInterval(timer);
  revealed = 0;
  shown = 0;
  decided = null;
  path.setLatLngs([]);
  ahead.setLatLngs([]);
  fill.setLatLngs([]);
  tracker.remove();
  for (const cam of chase.cameras) markers[cam.id].setIcon(camIcon(cam));
  setStatus(`Watching ${chase.cameras.length} cameras`);
  watching(`No open crimes. All ${chase.cameras.length} cameras are watching.`);
}

// Before a crime is found: one camera's clip at a time, cycling through all of them.
function watching(note, i = 0) {
  const cam = chase.cameras[i % chase.cameras.length];
  els.feeds.innerHTML = `
    <div class="feeds-calm"><span class="feeds-calm-dot"></span><span>${note}</span></div>
    <figure class="watch-tile">
      <video src="${cam.video}" autoplay muted playsinline></video>
      <figcaption>${cam.name}</figcaption>
    </figure>`;
  const id = run;
  const next = () => { if (id === run && revealed === 0) watching(note, i + 1); };
  els.feeds.querySelector("video").onended = next;
}

// Moves the chase on a clock as long as each clip, so the map runs even if a browser blocks autoplay.
function tick() {
  const step = steps[revealed - 1];
  const length = (camera(step.camera).duration || 5) * 1000;
  const share = Math.min((performance.now() - stepStart) / length, 1);
  const pts = ahead.getLatLngs();
  if (pts.length === 2) {
    const [a, b] = pts;
    const tip = [a.lat + (b.lat - a.lat) * share, a.lng + (b.lng - a.lng) * share];
    fill.setLatLngs([a, tip]);
    tracker.setLatLng(tip);
  }
  if (share < 1) return;
  clearInterval(timer);
  if (revealed < steps.length) reveal();
  else finish();
}

// One step = one camera that saw this crime. Called in order, so the chase grows camera by camera.
function reveal() {
  const step = steps[revealed];
  const cam = camera(step.camera);
  revealed++;
  markers[cam.id].setIcon(camIcon(cam, revealed === 1 ? "is-alert" : "is-chase"));
  path.addLatLng([cam.lat, cam.lng]);
  fill.setLatLngs([]);
  tracker.setLatLng([cam.lat, cam.lng]).addTo(map);
  const next = steps[revealed] && camera(steps[revealed].camera);
  ahead.setLatLngs(next ? [[cam.lat, cam.lng], [next.lat, next.lng]] : []);
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
  const done = revealed === steps.length;
  const report = chase.dispatch;
  const reportOpen = els.feeds.querySelector(".dispatch-report:not([hidden])") !== null || (done && !decided && !els.feeds.dataset.closed);

  els.feeds.innerHTML = `
    <section class="feed">
      <header class="feed-head">
        <span class="feed-dot"></span>
        <strong>${steps[0].type}</strong>
        <span class="feed-cam">${revealed === 1 ? "Crime camera" : `Camera ${revealed}`}</span>
        <span class="feed-spacer"></span>
        <button class="dispatch-btn${done && report ? " is-ready" : ""}${decided ? " is-decided" : ""}" ${done && report ? "" : "disabled"}>Dispatch report</button>
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
        <p class="dispatch-action">${report.recommendation}</p>
        <p class="dispatch-procedure">Procedure: ${report.procedure}</p>
        <p class="dispatch-suspect">Suspect: ${chase.suspect}</p>
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

  els.feeds.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => show(Number(b.dataset.go))));
  els.feeds.querySelector(".dispatch-btn").onclick = () => {
    const box = els.feeds.querySelector(".dispatch-report");
    box.hidden = !box.hidden;
    els.feeds.dataset.closed = box.hidden ? "1" : "";
  };
  els.feeds.querySelector(".dispatch-close")?.addEventListener("click", () => {
    els.feeds.querySelector(".dispatch-report").hidden = true;
    els.feeds.dataset.closed = "1";
  });
  els.feeds.querySelector(".dispatch-confirm")?.addEventListener("click", () => decide("Confirmed"));
  els.feeds.querySelector(".dispatch-dismiss")?.addEventListener("click", () => decide("Dismissed"));
}

function finish() {
  if (decided) return;
  const last = steps.at(-1);
  setStatus(`Last seen at ${camera(last.camera).name}, ${clock(last.time)}. Needs your decision`, true);
  // Open the report in place, so the last clip stays on its final frame.
  const box = els.feeds.querySelector(".dispatch-report");
  if (!box) return;
  box.hidden = false;
  const button = els.feeds.querySelector(".dispatch-btn");
  button.disabled = false;
  button.classList.add("is-ready");
}

function decide(word) {
  decided = word;
  setStatus(`${word}. Last seen at ${camera(steps.at(-1).camera).name}`);
  render();
}

function replay() {
  run++;
  delete els.feeds.dataset.closed;
  reset();
  if (!steps.length) return setStatus("No crime found");
  const id = run;
  setTimeout(() => { if (id === run) reveal(); }, 800);
}

async function live() {
  els.live.disabled = els.replay.disabled = true;
  run++;
  if (chase) {
    reset();
    watching("Gemma 4 is checking every camera for a crime…");
  }
  setStatus("Gemma 4 is watching 3 cameras…");
  try {
    const res = await fetch("/api/run", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    load(await res.json());
    replay();
  } catch (err) {
    setStatus(`Live run failed: ${err.message}`, true);
  } finally {
    els.live.disabled = els.replay.disabled = false;
  }
}

els.replay.onclick = replay;
els.live.onclick = live;

fetch("data/chase.json")
  .then((r) => r.json())
  .then((data) => {
    load(data);
    replay();
  })
  .catch(() => setStatus("No saved run yet. Click Run Gemma live."));
