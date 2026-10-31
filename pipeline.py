"""Gemma 4 watches each camera: spot the crime on the first one, then look for the suspect on the rest."""
import base64
import json
import os
import subprocess
import tempfile
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent
MODEL = "gemma-4-31b-it"  # spotting the crime: the smaller model missed it in testing
FAST_MODEL = "gemma-4-26b-a4b-it"  # matching and dispatch: ~4 s per call instead of ~20 s
FPS = 2

CAMERAS = [
    {"id": "cam1", "name": "Camera 1", "source": "videos/IMG_7493.mov", "video": "videos/cam1.mp4"},
    # Phone GPS put this one a few meters west of where it was filmed: (lat, lng) nudge.
    {"id": "cam2", "name": "Camera 2", "source": "videos/IMG_7494.mov", "video": "videos/cam2.mp4", "move": (-0.00003, 0.00015)},
    {"id": "cam3", "name": "Camera 3", "source": "videos/IMG_7495.mov", "video": "videos/cam3.mp4"},
]

SPOT_PROMPT = """You are a public-safety camera monitor. These frames are from one street camera, {gap} seconds apart, in order, numbered from 1.
Judge only the physical actions, not costumes or mood. Treat any of these as a crime: grabbing or snatching an item from someone, shoving or knocking someone down, hitting, or a person fleeing after physical contact with someone who ends up on the ground.
Reply as JSON: {{"crime": bool, "type": "robbery|assault|theft|none", "frame": number of the frame where the crime happens, "what_happened": one sentence, "suspect": clothing, build and hair of the person who did it, "direction": which way the suspect left the frame}}"""

MATCH_PROMPT = """You are a public-safety camera monitor following a suspect. These frames are from one street camera, {gap} seconds apart, in order, numbered from 1.
Suspect: {suspect}
Is the suspect in these frames? Match on clothing and build.
Reply as JSON: {{"match": bool, "confidence": 0 to 1, "frame": number of the frame where the suspect is clearest, "what_they_did": one sentence, "direction": which way they left the frame}}"""

DISPATCH_PROMPT = """You are a police dispatcher. A person reviews your report before anyone is sent.
What the cameras saw, in time order:
{timeline}
Suspect: {suspect}
Reply as JSON: {{"priority": "low|medium|high", "recommendation": one sentence saying where to send an officer (where the suspect was last seen, not the crime scene), "procedure": one short sentence of steps for the officer}}"""


def load_key() -> str:
    if "GEMINI_API_KEY" not in os.environ:
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                os.environ["GEMINI_API_KEY"] = line.split("=", 1)[1].strip()
    return os.environ["GEMINI_API_KEY"]


def camera_info(path: Path) -> dict:
    """Read the GPS spot and start time the iPhone saved in the video."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", str(path)],
        capture_output=True, text=True, check=True,
    )
    fmt = json.loads(out.stdout)["format"]
    tags = fmt["tags"]
    # ISO 6709, e.g. "+35.7726-078.6750+109.030/"
    loc = tags["com.apple.quicktime.location.ISO6709"]
    lat, lng = loc[:8], loc[8:17]
    return {
        "lat": float(lat),
        "lng": float(lng),
        "duration": float(fmt["duration"]),
        "start": datetime.strptime(tags["com.apple.quicktime.creationdate"], "%Y-%m-%dT%H:%M:%S%z"),
    }


def frames(path: Path) -> list[bytes]:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={FPS},scale=768:-1", f"{tmp}/%03d.jpg"],
            check=True,
        )
        return [p.read_bytes() for p in sorted(Path(tmp).glob("*.jpg"))]


def ask_gemma(images: list[bytes], prompt: str, model: str = MODEL) -> tuple[dict, str]:
    """Returns Gemma's JSON answer and the reasoning it wrote before it."""
    parts = [{"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(i).decode()}} for i in images]
    parts.append({"text": prompt})
    body = {"contents": [{"parts": parts}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0}}
    request = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": load_key()},
    )
    reply = json.load(urllib.request.urlopen(request, timeout=180))
    # Gemma returns its reasoning first; the JSON answer is the last part.
    texts = [p.get("text", "") for p in reply["candidates"][0]["content"]["parts"]]
    answer = json.loads(texts[-1])
    # The smaller Gemma sometimes wraps its answer in a list.
    if isinstance(answer, list):
        answer = answer[0]
    return answer, "\n".join(texts[:-1]).strip()


def event(camera: dict, info: dict, frame: int, **fields) -> dict:
    offset = max(frame - 1, 0) / FPS
    return {"camera": camera["id"], "offset_s": offset, "time": (info["start"] + timedelta(seconds=offset)).isoformat(), **fields}


def run(on_step=lambda step: None) -> dict:
    """on_step gets each stage as it happens, so the dashboard can show Gemma working live."""
    infos = {c["id"]: camera_info(ROOT / c["source"]) for c in CAMERAS}
    cameras = [
        {**c, "lat": infos[c["id"]]["lat"] + c.get("move", (0, 0))[0], "lng": infos[c["id"]]["lng"] + c.get("move", (0, 0))[1],
         "duration": infos[c["id"]]["duration"]}
        for c in CAMERAS
    ]
    on_step({"stage": "cameras", "cameras": cameras})
    first, rest = CAMERAS[0], CAMERAS[1:]

    images = frames(ROOT / first["source"])
    on_step({"stage": "asking", "camera": first["id"], "frames": len(images), "question": "Is a crime happening?"})
    spot, thought = ask_gemma(images, SPOT_PROMPT.format(gap=1 / FPS))
    events = [event(first, infos[first["id"]], spot.get("frame") or 1, kind="crime" if spot["crime"] else "clear",
                    type=spot.get("type"), text=spot.get("what_happened"), direction=spot.get("direction"))]
    on_step({"stage": "answer", "camera": first["id"], "thought": thought, "event": events[0], "suspect": spot.get("suspect")})

    if spot["crime"]:
        prompt = MATCH_PROMPT.format(gap=1 / FPS, suspect=spot["suspect"])
        for camera in rest:
            images = frames(ROOT / camera["source"])
            on_step({"stage": "asking", "camera": camera["id"], "frames": len(images), "question": "Is the suspect here?"})
            match, thought = ask_gemma(images, prompt, FAST_MODEL)
            events.append(event(camera, infos[camera["id"]], match.get("frame") or 1,
                                kind="sighting" if match["match"] else "clear", confidence=match.get("confidence"),
                                text=match.get("what_they_did"), direction=match.get("direction")))
            on_step({"stage": "answer", "camera": camera["id"], "thought": thought, "event": events[-1]})

    events.sort(key=lambda e: e["time"])
    dispatch = None
    if spot["crime"]:
        names = {c["id"]: c["name"] for c in CAMERAS}
        timeline = "\n".join(
            f"- {datetime.fromisoformat(e['time']):%I:%M:%S %p} at {names[e['camera']]}: {e['kind']}. {e['text']} Left heading {e['direction']}."
            for e in events if e["kind"] != "clear"
        )
        on_step({"stage": "asking", "camera": None, "frames": 0, "question": "Where should an officer go?"})
        dispatch, thought = ask_gemma([], DISPATCH_PROMPT.format(timeline=timeline, suspect=spot["suspect"]), FAST_MODEL)
        on_step({"stage": "dispatch", "thought": thought, "dispatch": dispatch})

    result = {
        "models": [MODEL, FAST_MODEL],
        "suspect": spot.get("suspect") if spot["crime"] else None,
        "dispatch": dispatch,
        "cameras": cameras,
        "events": events,
    }
    out = ROOT / "web" / "data" / "chase.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, indent=2))
    on_step({"stage": "done"})
    return result


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
