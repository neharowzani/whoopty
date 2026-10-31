# whoopty

A Gemma experiment for flagging possible assault and theft in our team's recorded demos, inspired by [Clarity](https://github.com/waliviqas/clarity-hackathon-n-r).

We're building this one small step at a time on the `arjun` branch.

## Step 1: one clip, one observation

`analyze_clip.py` reads a short window from a local video and samples eight images. A vision-capable Gemma endpoint can review those images and return:

- `assault`, `theft`, `both`, `none`, or `uncertain`;
- a description of visible actions;
- what remains uncertain;
- references to supporting frames, converted to video timestamps by our code.

This is a first model experiment, not a finished application. There is no dashboard, live camera system, or deployment. No GPU has been rented or endpoint configured.

## Install

Use Python 3.10 or later:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

## Check a video without Gemma

```sh
python analyze_clip.py /path/to/assault-demo.mp4 --dry-run
```

This only checks local video decoding and reports the sampled timestamps. It sends no images anywhere and produces no prediction. By default, the script samples eight frames from the first 12 seconds. To look at another section:

```sh
python analyze_clip.py /path/to/theft-demo.mp4 --start 10 --seconds 12 --dry-run
```

One run checks only the specified window, not the whole video. Windows are limited to 30 seconds and 2–8 sampled frames. Audio is not used. Variable-frame-rate footage may need conversion if its decoder does not provide usable timestamps.

## Run real Gemma inference later

We'll choose and connect the cloud GPU in a separate step. The script expects these environment variables:

| Variable | Meaning |
| --- | --- |
| `GEMMA_BASE_URL` | HTTPS OpenAI-compatible API base URL, usually ending in `/v1` |
| `GEMMA_API_KEY` | The private endpoint's authentication key |
| `GEMMA_MODEL` | Exact served name of a vision-capable Gemma checkpoint |

The server must accept multiple image inputs and strict JSON-schema output through `/chat/completions`. Its image limit must be at least the requested frame count. Text-only Gemma checkpoints cannot run this experiment. Credentials are read from the environment, never committed or included in output. The script does not automatically load `.env` files.

Once configured:

```sh
python analyze_clip.py /path/to/assault-demo.mp4 --output outputs/assault-01.json
```

Running without `--dry-run` sends the sampled images to the configured endpoint. A failed or incomplete model response is an error; it is never replaced with a simulated prediction. Existing output files are not overwritten.

## First evaluation

Next, run one assault demo, one theft demo, and a normal clip with neither action. Compare the result with what actually happens in each window. Keep expected labels outside the prompt; filenames are not sent to Gemma. We have not measured accuracy, and Clarity's results do not carry over to this model.

These are suspected events for human review, not proof that a crime occurred. In particular, ownership, permission, and intent may be invisible in theft footage. Sparse frames can miss motion or brief events; `none` means no supported event in the sampled frames, not that the complete video is clear. Evidence timestamps refer to sampled frames, not exact incident onset or duration.

Recorded videos under `videos/` and results under `outputs/` are ignored by Git. Common video extensions are also ignored. No identity recognition, cross-camera tracking, or automatic dispatch is part of this experiment.

## Verify

```sh
python -m unittest discover -s tests -v
```

Tests exercise result validation, timestamps, payloads, incomplete responses, local-only mode, and real decoding of a generated non-incident video. Model inference tests are mocked until a real Gemma endpoint is connected.
