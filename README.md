# Clarity (whoopty)

Gemma 4 watches street cameras, spots a crime on one, describes the suspect, then finds them on the next cameras and traces the chase on a map.

## Run

1. Put `GEMINI_API_KEY=...` in `.env` (a key from a billed Google AI Studio project).
2. `python3 server.py` and open http://localhost:8000
3. The page loads paused. **▶ Play** starts Gemma 4 watching all cameras in the background (~30 s) and streams its reasoning into the page. Nothing plays until Gemma calls the crime: then the crime clip pops up from just before the moment, and each next camera plays from just before the suspect appears, lighting up its camera and stretch of path when he's in frame. **Replay chase** plays the last saved run the same way (backup if the network is down).

`python3 pipeline.py` runs Gemma from the terminal and rewrites `web/data/chase.json`.

## How it works

- `pipeline.py`: cuts 2 frames per second from each video with ffmpeg, asks Gemma 4 whether camera 1 shows a crime and who did it (`gemma-4-31b-it`), then asks whether cameras 2 and 3 show that suspect (`gemma-4-26b-a4b-it`, faster); cameras 2 and 3 are checked at the same time. Camera GPS and start time come from the iPhone video metadata.
- `server.py`: serves `web/`; `GET /api/live` streams each pipeline step (and Gemma's reasoning) as server-sent events, `POST /api/run` returns the whole result.
- `web/`: dashboard in the Clarity style: dark Leaflet map with the suspect's path, and one crime card that plays each camera in turn (Crime → Cam 2 → Cam 3) and ends on the dispatch report with Confirm / Dismiss.

Needs Python 3 and ffmpeg. No Python packages.
