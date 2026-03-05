"""
Video Dubbing Backend — FastAPI (ElevenLabs Only)
Pipeline: Upload → FFmpeg extract audio → ElevenLabs Dubbing API → Wav2Lip → Output
"""

import os, uuid, shutil, subprocess, asyncio, json
from pathlib import Path
from typing import Optional, List

import httpx
from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# ── Config ───────────────────────────────────────────────────
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
EL_BASE            = "https://api.elevenlabs.io/v1"

BASE_DIR   = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
WAV2LIP_DIR = BASE_DIR / "Wav2Lip"

for d in [UPLOAD_DIR, OUTPUT_DIR]:
    d.mkdir(exist_ok=True)

# ── App ──────────────────────────────────────────────────────
app = FastAPI(title="Video Dubbing API — ElevenLabs", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# ── Job store ─────────────────────────────────────────────────
jobs: dict = {}

SUPPORTED_LANGUAGES = [
    {"code": "es", "label": "Spanish",    "flag": "🇪🇸"},
    {"code": "fr", "label": "French",     "flag": "🇫🇷"},
    {"code": "de", "label": "German",     "flag": "🇩🇪"},
    {"code": "ja", "label": "Japanese",   "flag": "🇯🇵"},
    {"code": "pt", "label": "Portuguese", "flag": "🇧🇷"},
    {"code": "zh", "label": "Chinese",    "flag": "🇨🇳"},
    {"code": "ar", "label": "Arabic",     "flag": "🇸🇦"},
    {"code": "hi", "label": "Hindi",      "flag": "🇮🇳"},
    {"code": "ko", "label": "Korean",     "flag": "🇰🇷"},
    {"code": "it", "label": "Italian",    "flag": "🇮🇹"},
    {"code": "ru", "label": "Russian",    "flag": "🇷🇺"},
    {"code": "nl", "label": "Dutch",      "flag": "🇳🇱"},
    {"code": "pl", "label": "Polish",     "flag": "🇵🇱"},
    {"code": "tr", "label": "Turkish",    "flag": "🇹🇷"},
    {"code": "sv", "label": "Swedish",    "flag": "🇸🇪"},
]

# ══════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════

def _get_api_key(request: Request) -> str:
    """
    Prefer a per-request header for ElevenLabs API key, fall back to server .env.
    Header name: X-EL-API-Key
    """
    hdr = request.headers.get("x-el-api-key") or request.headers.get("X-EL-API-Key")
    return hdr.strip() if hdr else ELEVENLABS_API_KEY


@app.get("/health")
async def health(request: Request):
    api_key = _get_api_key(request)
    key_ok = bool(api_key)
    wav2lip_ok = (WAV2LIP_DIR / "checkpoints").exists()

    # Quick ping to ElevenLabs
    el_ok = False
    plan = None
    if key_ok:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{EL_BASE}/user", headers={"xi-api-key": api_key})
                el_ok = r.status_code == 200
                if el_ok:
                    data = r.json() or {}
                    sub = data.get("subscription") or {}
                    # Different ElevenLabs accounts may expose "tier" or "name"
                    plan = sub.get("tier") or sub.get("name")
        except Exception:
            pass

    return {
        "status": "ok" if key_ok else "missing_key",
        "elevenlabs_key": key_ok,
        "elevenlabs_connected": el_ok,
        "plan": plan,
        "wav2lip": wav2lip_ok,
        "ffmpeg": _check_ffmpeg(),
    }


@app.get("/languages")
async def languages():
    return {"languages": SUPPORTED_LANGUAGES}


@app.get("/voices")
async def voices(request: Request):
    """Return voices from ElevenLabs account."""
    api_key = _get_api_key(request)
    if not api_key:
        raise HTTPException(401, "ELEVENLABS_API_KEY not set")
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{EL_BASE}/voices", headers={"xi-api-key": api_key})
        r.raise_for_status()
        raw = r.json().get("voices", [])
        return {
            "voices": [
                {
                    "id": v["voice_id"],
                    "name": v["name"],
                    "category": v.get("category", ""),
                    "preview_url": v.get("preview_url"),
                }
                for v in raw
            ]
        }


@app.post("/upload")
async def upload_video(request: Request, file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(400, "Only video files are accepted")
    api_key = _get_api_key(request)
    if not api_key:
        raise HTTPException(503, "ELEVENLABS_API_KEY not configured in .env or request header")

    upload_id = str(uuid.uuid4())
    ext  = Path(file.filename).suffix or ".mp4"
    dest = UPLOAD_DIR / f"{upload_id}{ext}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    return {
        "upload_id": upload_id,
        "filename":  file.filename,
        "url":       f"/uploads/{dest.name}",
    }


@app.post("/dub")
async def start_dub(
    request: Request,
    background_tasks: BackgroundTasks,
    upload_id:       str           = Form(...),
    target_language: str           = Form(...),
    lip_sync:        bool          = Form(False),
    num_speakers:    int           = Form(0),       # 0 = auto-detect
    watermark:       bool          = Form(False),
    target_accent:   Optional[str] = Form(None),
):
    matches = list(UPLOAD_DIR.glob(f"{upload_id}*"))
    if not matches:
        raise HTTPException(404, f"Upload {upload_id} not found")

    api_key = _get_api_key(request)
    if not api_key:
        raise HTTPException(503, "ELEVENLABS_API_KEY not configured in .env or request header")

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "job_id":      job_id,
        "status":      "queued",
        "progress":    0,
        "stage_label": "Queued…",
        "transcript":  None,
        "dubbed_audio_url":  None,
        "output_video_url":  None,
        "el_dubbing_id":     None,
        "error":       None,
    }

    background_tasks.add_task(
        run_pipeline,
        job_id, matches[0], target_language, lip_sync, num_speakers, watermark, api_key, target_accent
    )
    return {"job_id": job_id}


@app.get("/job/{job_id}")
async def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    return jobs[job_id]


@app.delete("/job/{job_id}")
async def delete_job(job_id: str):
    jobs.pop(job_id, None)
    return {"deleted": job_id}


# ══════════════════════════════════════════════════════════════
# PIPELINE
# ══════════════════════════════════════════════════════════════

async def run_pipeline(job_id, video_path, target_language, lip_sync, num_speakers, watermark, api_key: str, target_accent: Optional[str] = None):
    def upd(status, progress, label, **kw):
        jobs[job_id].update({"status": status, "progress": progress, "stage_label": label, **kw})

    try:
        headers = {"xi-api-key": api_key}

        # ── 1. Send to ElevenLabs Dubbing API ────────────────
        upd("uploading", 8, "Uploading to ElevenLabs…")

        async with httpx.AsyncClient(timeout=120) as c:
            with open(video_path, "rb") as vf:
                mime = _mime(video_path)
                data = {
                    "target_lang":        target_language,
                    "mode":               "automatic",
                    "num_speakers":       str(num_speakers),
                    "watermark":          str(watermark).lower(),
                    # Highest-resolution dubbing is Creator+ only; use default resolution
                    "highest_resolution": "false",
                }
                if target_accent:
                    data["target_accent"] = target_accent

                r = await c.post(
                    f"{EL_BASE}/dubbing",
                    headers=headers,
                    files={"file": (video_path.name, vf, mime)},
                    data=data,
                )
            if r.status_code != 200:
                raise RuntimeError(f"ElevenLabs upload error {r.status_code}: {r.text}")

            dub_data = r.json()
            dub_id   = dub_data["dubbing_id"]
            jobs[job_id]["el_dubbing_id"] = dub_id

        upd("dubbing", 18, f"ElevenLabs processing… (ID: {dub_id[:8]})")

        # ── 2. Poll ElevenLabs until done ─────────────────────
        async with httpx.AsyncClient(timeout=30) as c:
            for attempt in range(180):          # max ~15 min
                await asyncio.sleep(5)
                r = await c.get(f"{EL_BASE}/dubbing/{dub_id}", headers=headers)
                r.raise_for_status()
                info   = r.json()
                status = info.get("status", "")
                el_pct = info.get("progress", 0) or 0
                prog   = min(18 + int(el_pct * 0.52), 68)

                upd("dubbing", prog, f"ElevenLabs: {status} ({int(el_pct * 100)}%)")

                if status == "dubbed":
                    break
                if status in ("error", "failed", "not_found"):
                    raise RuntimeError(f"ElevenLabs dubbing failed: {info.get('error','unknown error')}")
            else:
                raise RuntimeError("ElevenLabs dubbing timed out (15 min)")

        # ── 3. Download dubbed audio ───────────────────────────
        upd("downloading", 70, "Downloading dubbed audio…")
        dubbed_audio = OUTPUT_DIR / f"{job_id}_dubbed.mp3"

        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.get(
                f"{EL_BASE}/dubbing/{dub_id}/audio/{target_language}",
                headers=headers,
            )
            if r.status_code != 200:
                raise RuntimeError(f"Failed to download audio: {r.status_code} {r.text}")
            dubbed_audio.write_bytes(r.content)

        upd("downloading", 76, "Audio downloaded ✓")

        # ── 4. Mux audio into original video ──────────────────
        upd("muxing", 80, "Merging audio into video…")
        muxed = OUTPUT_DIR / f"{job_id}_muxed.mp4"
        await ffmpeg([
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-i", str(dubbed_audio),
            "-c:v", "copy",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-shortest",
            str(muxed),
        ])

        final = muxed

        # ── 5. Wav2Lip (optional) ─────────────────────────────
        if lip_sync and WAV2LIP_DIR.exists():
            upd("lipsync", 86, "Running Wav2Lip…")
            lipsync_out = OUTPUT_DIR / f"{job_id}_lipsync.mp4"
            ok = await run_wav2lip(muxed, dubbed_audio, lipsync_out)
            if ok:
                final = lipsync_out
                upd("lipsync", 95, "Lip sync complete ✓")
            else:
                upd("lipsync", 95, "Lip sync skipped (model not found)")

        # ── 6. Done ───────────────────────────────────────────
        upd(
            "done", 100, "Dubbing complete ✓",
            output_video_url=f"/outputs/{final.name}",
            dubbed_audio_url=f"/outputs/{dubbed_audio.name}",
        )

    except Exception as e:
        jobs[job_id].update({
            "status":      "error",
            "progress":    0,
            "stage_label": "Error",
            "error":       str(e),
        })


# ══════════════════════════════════════════════════════════════
# WAV2LIP
# ══════════════════════════════════════════════════════════════

async def run_wav2lip(video: Path, audio: Path, out: Path) -> bool:
    ckpt = WAV2LIP_DIR / "checkpoints" / "wav2lip_gan.pth"
    if not ckpt.exists():
        ckpt = WAV2LIP_DIR / "checkpoints" / "wav2lip.pth"
    if not ckpt.exists() or not (WAV2LIP_DIR / "inference.py").exists():
        return False

    cmd = [
        "python", str(WAV2LIP_DIR / "inference.py"),
        "--checkpoint_path", str(ckpt),
        "--face",  str(video),
        "--audio", str(audio),
        "--outfile", str(out),
        "--resize_factor", "1",
        "--pads", "0", "10", "0", "0",
        "--nosmooth",
    ]

    loop = asyncio.get_event_loop()
    def _run():
        res = subprocess.run(cmd, cwd=str(WAV2LIP_DIR), capture_output=True, text=True, timeout=600)
        return res.returncode == 0

    try:
        return await loop.run_in_executor(None, _run)
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════
# UTILS
# ══════════════════════════════════════════════════════════════

async def ffmpeg(cmd: list):
    loop = asyncio.get_event_loop()
    def _run():
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {res.stderr[-600:]}")
    await loop.run_in_executor(None, _run)


def _mime(path: Path) -> str:
    ext = path.suffix.lower()
    return {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
            ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}.get(ext, "video/mp4")


def _check_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=3)
        return True
    except Exception:
        return False