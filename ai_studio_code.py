#!/usr/bin/env python3
# ============================================================
# LUMENIX AI - SINGLE-FILE VIDEO BACKEND
# Colab / Linux | FastAPI | CogVideoX | FFmpeg | Piper | Cloudflare
#
# IMPORTANT:
# - Run this file in Google Colab with a GPU runtime.
# - First model load downloads a large model and can take time.
# - CogVideoX-2B needs substantial GPU RAM; a free Colab GPU may
#   run out of memory or disconnect. This is not guaranteed.
# - This backend currently implements TEXT-to-video. Image-to-video,
#   subtitles, transitions, and frontend adapter matching require
#   separate implementation/testing.
# ============================================================

import os
import sys
import re
import json
import time
import uuid
import base64
import shutil
import threading
import subprocess
import urllib.request
from pathlib import Path
from typing import Optional, List

# -------------------- CONFIG --------------------

BASE_DIR = Path("/tmp/lumenix_jobs")
OUTPUT_DIR = BASE_DIR / "outputs"
TEMP_DIR = BASE_DIR / "temp"
PIPER_DIR = Path("/tmp/piper_voices")

for folder in (BASE_DIR, OUTPUT_DIR, TEMP_DIR, PIPER_DIR):
    folder.mkdir(parents=True, exist_ok=True)

HOST = os.environ.get("LUMENIX_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
MODEL_ID = os.environ.get("LUMENIX_MODEL_ID", "THUDM/CogVideoX-2b")
API_KEY = os.environ.get("LUMENIX_API_KEY", "")  # Optional; set a secret for public deployments.
FPS = 8
MAX_FRAMES = 49
MAX_AUDIO_BYTES = 30 * 1024 * 1024

# -------------------- SYSTEM DEPENDENCIES --------------------

def run_command(command, check=True, timeout=None):
    return subprocess.run(
        command,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout
    )

def ensure_system_tools():
    if shutil.which("ffmpeg") is None:
        # Colab/Linux installation. Requires an internet connection.
        run_command(["bash", "-lc", "apt-get -qq update && apt-get -qq install -y ffmpeg"], timeout=600)

    cloudflared_path = Path("/usr/local/bin/cloudflared")
    if not cloudflared_path.exists():
        cloudflared_path = Path("/tmp/cloudflared")
    if not cloudflared_path.exists():
        url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        try:
            urllib.request.urlretrieve(url, str(cloudflared_path))
            cloudflared_path.chmod(0o755)
        except Exception as exc:
            print("Cloudflared download skipped:", exc)

ensure_system_tools()

# Install Python dependencies if missing. PyTorch is supplied by Colab where possible.
def ensure_python_packages():
    packages = [
        "fastapi", "uvicorn[standard]", "diffusers", "transformers",
        "accelerate", "sentencepiece", "safetensors",
        "imageio", "imageio-ffmpeg", "pillow", "python-multipart",
        "piper-tts"
    ]
    run_command([sys.executable, "-m", "pip", "install", "-q"] + packages, timeout=1200)

ensure_python_packages()

import torch
from PIL import Image
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import uvicorn

# -------------------- OPTIONAL PIPER VOICE --------------------

PIPER_MODEL = PIPER_DIR / "en_US-lessac-medium.onnx"
PIPER_CONFIG = PIPER_DIR / "en_US-lessac-medium.onnx.json"

def download_piper_voice():
    files = [
        (
            PIPER_MODEL,
            "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
        ),
        (
            PIPER_CONFIG,
            "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
        )
    ]
    for path, url in files:
        if not path.exists():
            try:
                print("Downloading optional Piper voice:", path.name)
                urllib.request.urlretrieve(url, str(path))
            except Exception as exc:
                print("Piper voice download failed:", exc)

download_piper_voice()

# -------------------- FASTAPI --------------------

app = FastAPI(title="Lumenix AI Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

jobs = {}
jobs_lock = threading.Lock()
model_lock = threading.Lock()
video_pipeline = None
model_load_error = None
tunnel_process = None

def authorize(x_lumenix_api_key: Optional[str]):
    if API_KEY and x_lumenix_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

def gpu_status():
    if not torch.cuda.is_available():
        return {
            "available": False,
            "gpu": None,
            "vramTotalGb": 0,
            "vramFreeGb": 0,
            "message": "CUDA GPU is not available. Select a GPU runtime in Colab."
        }
    try:
        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        return {
            "available": True,
            "gpu": torch.cuda.get_device_name(0),
            "vramTotalGb": round(total_bytes / (1024 ** 3), 2),
            "vramFreeGb": round(free_bytes / (1024 ** 3), 2)
        }
    except Exception as exc:
        return {"available": False, "gpu": None, "error": str(exc)}

@app.get("/")
def root():
    return {"app": "Lumenix AI", "status": "running", "version": "1.0.0"}

@app.get("/health")
def health():
    return {
        "status": "healthy",
        "gpu": gpu_status(),
        "activeJobs": sum(1 for job in jobs.values() if job["status"] in ("queued", "processing"))
    }

@app.get("/gpu-status")
def get_gpu_status():
    return gpu_status()

# -------------------- REQUEST SCHEMAS --------------------

class VideoRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    aspectRatio: str = "9:16"
    frames: int = Field(default=49, ge=9, le=49)
    steps: int = Field(default=30, ge=10, le=50)
    guidanceScale: float = Field(default=6.0, ge=1.0, le=12.0)

class StitchRequest(BaseModel):
    shotIds: List[str] = Field(min_length=1, max_length=20)
    voiceoverAudioBase64: Optional[str] = None
    musicAudioBase64: Optional[str] = None
    voiceVolume: float = Field(default=1.0, ge=0.0, le=2.0)
    musicVolume: float = Field(default=0.25, ge=0.0, le=2.0)

class VoiceRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)

# -------------------- MODEL --------------------

def load_video_model():
    global video_pipeline, model_load_error
    with model_lock:
        if video_pipeline is not None:
            return video_pipeline
        if not torch.cuda.is_available():
            raise RuntimeError("No CUDA GPU detected. Enable GPU runtime in Colab.")
        try:
            from diffusers import CogVideoXPipeline
            print("Loading model:", MODEL_ID)
            pipe = CogVideoXPipeline.from_pretrained(
                MODEL_ID,
                torch_dtype=torch.float16
            )
            # Offloads model components to CPU to reduce VRAM demand.
            pipe.enable_model_cpu_offload()
            try:
                pipe.vae.enable_slicing()
                pipe.vae.enable_tiling()
            except Exception:
                pass
            video_pipeline = pipe
            model_load_error = None
            print("CogVideoX model loaded.")
            return video_pipeline
        except Exception as exc:
            model_load_error = str(exc)
            raise RuntimeError("Could not load video model: " + str(exc))

def dimensions_for_ratio(ratio):
    # CogVideoX 2B generates its native landscape frame size.
    # The final MP4 is resized/cropped to the selected output ratio.
    sizes = {
        "9:16": (480, 704),
        "16:9": (704, 480),
        "1:1": (512, 512)
    }
    if ratio not in sizes:
        raise ValueError("aspectRatio must be 9:16, 16:9, or 1:1")
    return sizes[ratio]

# -------------------- FFMPEG HELPERS --------------------

def ffmpeg(args, timeout=900):
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + [str(x) for x in args]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError("FFmpeg failed: " + result.stderr[-2500:])
    return result

def normalize_video(source: Path, destination: Path, ratio: str):
    width, height = dimensions_for_ratio(ratio)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={FPS}"
    )
    ffmpeg([
        "-i", str(source),
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-an",
        "-movflags", "+faststart",
        str(destination)
    ])

def decode_audio(data: Optional[str], destination: Path):
    if not data:
        return None
    payload = data.split(",", 1)[1] if data.startswith("data:") and "," in data else data
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception:
        raise ValueError("Invalid base64 audio")
    if not raw or len(raw) > MAX_AUDIO_BYTES:
        raise ValueError("Audio is empty or exceeds 30 MB")
    destination.write_bytes(raw)
    return destination

# -------------------- GENERATION JOB --------------------

def run_generation(job_id: str, request: VideoRequest):
    raw_path = TEMP_DIR / f"{job_id}_raw.mp4"
    final_path = OUTPUT_DIR / f"{job_id}.mp4"
    try:
        with jobs_lock:
            jobs[job_id]["status"] = "processing"
            jobs[job_id]["progress"] = 2

        pipe = load_video_model()

        # CogVideoX expects frame counts of 8n+1.
        frame_count = max(9, min(request.frames, MAX_FRAMES))
        frame_count = ((frame_count - 1) // 8) * 8 + 1

        with jobs_lock:
            jobs[job_id]["progress"] = 10

        from diffusers.utils import export_to_video
        with torch.inference_mode():
            output = pipe(
                prompt=request.prompt,
                num_frames=frame_count,
                num_inference_steps=request.steps,
                guidance_scale=request.guidanceScale
            )

        with jobs_lock:
            jobs[job_id]["progress"] = 80

        export_to_video(output.frames[0], str(raw_path), fps=FPS)
        normalize_video(raw_path, final_path, request.aspectRatio)
        raw_path.unlink(missing_ok=True)

        with jobs_lock:
            jobs[job_id].update({
                "status": "completed",
                "progress": 100,
                "file": str(final_path),
                "error": None
            })
    except Exception as exc:
        with jobs_lock:
            jobs[job_id].update({
                "status": "failed",
                "progress": 0,
                "error": str(exc)
            })
        print("Generation failed:", repr(exc))
    finally:
        raw_path.unlink(missing_ok=True)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

@app.post("/jobs/start")
def start_generation(request: VideoRequest, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)
    if not request.prompt.strip():
        raise HTTPException(400, "Prompt cannot be empty")
    try:
        dimensions_for_ratio(request.aspectRatio)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {
            "jobId": job_id,
            "status": "queued",
            "progress": 0,
            "file": None,
            "error": None
        }

    threading.Thread(target=run_generation, args=(job_id, request), daemon=True).start()
    return {"jobId": job_id, "status": "queued"}

@app.get("/jobs/status/{job_id}")
def job_status(job_id: str, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        return {
            "jobId": job["jobId"],
            "status": job["status"],
            "progress": job["progress"],
            "error": job["error"],
            "downloadUrl": f"/file/{job_id}" if job["status"] == "completed" else None
        }

@app.get("/file/{job_id}")
def download_video(job_id: str, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)
    with jobs_lock:
        job = jobs.get(job_id)
    if not job or job["status"] != "completed":
        raise HTTPException(404, "Video is not ready")
    path = Path(job["file"])
    if not path.is_file():
        raise HTTPException(404, "Video file no longer exists")
    return FileResponse(str(path), media_type="video/mp4", filename=f"lumenix_{job_id}.mp4")

# -------------------- PIPER TEXT-TO-SPEECH --------------------

@app.post("/voice/generate")
def generate_voice(request: VoiceRequest, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)
    piper = shutil.which("piper")
    if not piper:
        raise HTTPException(503, "Piper executable is not installed")
    if not PIPER_MODEL.exists() or not PIPER_CONFIG.exists():
        raise HTTPException(503, "Piper voice model is missing")
    voice_id = str(uuid.uuid4())
    output = OUTPUT_DIR / f"{voice_id}.wav"
    try:
        subprocess.run(
            [piper, "--model", str(PIPER_MODEL), "--config", str(PIPER_CONFIG), "--output_file", str(output)],
            input=request.text,
            text=True,
            capture_output=True,
            check=True,
            timeout=120
        )
    except Exception as exc:
        output.unlink(missing_ok=True)
        raise HTTPException(500, "Piper voice generation failed: " + str(exc))
    return {"status": "completed", "jobId": voice_id, "file": f"/voice/file/{voice_id}"}

@app.get("/voice/file/{voice_id}")
def download_voice(voice_id: str, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)
    path = OUTPUT_DIR / f"{voice_id}.wav"
    if not path.is_file():
        raise HTTPException(404, "Voice file not found")
    return FileResponse(str(path), media_type="audio/wav", filename=f"lumenix_voice_{voice_id}.wav")

# -------------------- MULTI-SHOT STITCHING --------------------

@app.post("/stitch")
def stitch_videos(request: StitchRequest, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)

    source_files = []
    for shot_id in request.shotIds:
        with jobs_lock:
            job = jobs.get(shot_id)
        if not job or job["status"] != "completed":
            raise HTTPException(400, f"Shot is not completed: {shot_id}")
        path = Path(job["file"])
        if not path.is_file():
            raise HTTPException(404, f"Shot file missing: {shot_id}")
        source_files.append(path)

    output_id = str(uuid.uuid4())
    list_file = TEMP_DIR / f"{output_id}_concat.txt"
    silent_file = TEMP_DIR / f"{output_id}_joined.mp4"
    final_file = OUTPUT_DIR / f"{output_id}.mp4"
    normalized_files = []

    try:
        # Normalize every shot to the same size, codec, and frame rate.
        for index, source in enumerate(source_files):
            normalized = TEMP_DIR / f"{output_id}_{index}.mp4"
            # Use each source's actual dimensions as 9:16 by default;
            # frontend should generate all shots with the same ratio.
            normalize_video(source, normalized, "9:16")
            normalized_files.append(normalized)

        with list_file.open("w", encoding="utf-8") as handle:
            for path in normalized_files:
                escaped = str(path).replace("'", "'\\''")
                handle.write(f"file '{escaped}'\n")

        ffmpeg([
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "23", "-pix_fmt", "yuv420p", "-an",
            str(silent_file)
        ])

        voice_path = decode_audio(
            request.voiceoverAudioBase64,
            TEMP_DIR / f"{output_id}_voice.bin"
        )
        music_path = decode_audio(
            request.musicAudioBase64,
            TEMP_DIR / f"{output_id}_music.bin"
        )

        if voice_path or music_path:
            inputs = ["-i", str(silent_file)]
            if voice_path:
                inputs += ["-i", str(voice_path)]
            if music_path:
                inputs += ["-i", str(music_path)]

            audio_index = 1
            filters = []
            labels = []
            if voice_path:
                filters.append(f"[{audio_index}:a]volume={request.voiceVolume}[voice]")
                labels.append("[voice]")
                audio_index += 1
            if music_path:
                filters.append(f"[{audio_index}:a]volume={request.musicVolume}[music]")
                labels.append("[music]")

            if len(labels) == 2:
                filters.append("".join(labels) + "amix=inputs=2:duration=first[aout]")
            else:
                filters.append(labels[0] + "anull[aout]")

            ffmpeg(
                inputs + [
                    "-filter_complex", ";".join(filters),
                    "-map", "0:v:0", "-map", "[aout]",
                    "-c:v", "copy", "-c:a", "aac",
                    "-shortest", "-movflags", "+faststart",
                    str(final_file)
                ]
            )
        else:
            shutil.move(str(silent_file), str(final_file))

        # Register stitched output so /file/{job_id} works.
        with jobs_lock:
            jobs[output_id] = {
                "jobId": output_id,
                "status": "completed",
                "progress": 100,
                "file": str(final_file),
                "error": None
            }

        return {
            "status": "completed",
            "jobId": output_id,
            "file": f"/file/{output_id}",
            "downloadUrl": f"/file/{output_id}"
        }

    except Exception as exc:
        final_file.unlink(missing_ok=True)
        raise HTTPException(500, "Stitching failed: " + str(exc))
    finally:
        list_file.unlink(missing_ok=True)
        silent_file.unlink(missing_ok=True)
        for path in normalized_files:
            path.unlink(missing_ok=True)

# -------------------- DELETE JOB --------------------

@app.delete("/jobs/{job_id}")
def delete_job(job_id: str, x_lumenix_api_key: Optional[str] = Header(None)):
    authorize(x_lumenix_api_key)
    with jobs_lock:
        job = jobs.pop(job_id, None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("file"):
        Path(job["file"]).unlink(missing_ok=True)
    return {"status": "deleted", "jobId": job_id}

# -------------------- CLOUDFLARE QUICK TUNNEL --------------------

def start_cloudflare_tunnel():
    global tunnel_process
    candidates = [
        shutil.which("cloudflared"),
        "/usr/local/bin/cloudflared",
        "/tmp/cloudflared",
        "/content/cloudflared"
    ]
    executable = next((p for p in candidates if p and Path(p).is_file()), None)
    if not executable:
        print("Cloudflare Tunnel unavailable: cloudflared binary not found.")
        return

    try:
        tunnel_process = subprocess.Popen(
            [executable, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        for line in tunnel_process.stdout:
            print("[CLOUDFLARE]", line.rstrip())
            match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
            print("\nLUMENIX PUBLIC API URL:", match.group(0), "\n")
    except Exception as exc:
        print("Cloudflare Tunnel error:", exc)

# -------------------- START --------------------

if __name__ == "__main__":
    print("\\n" + "=" * 58)
    print("LUMENIX AI BACKEND")
    print("=" * 58)
    print("GPU STATUS:", json.dumps(gpu_status(), indent=2))
    print("Local API: http://127.0.0.1:" + str(PORT))
    print("API docs:  http://127.0.0.1:" + str(PORT) + "/docs")
    print("Starting Cloudflare Quick Tunnel...")

    threading.Thread(target=start_cloudflare_tunnel, daemon=True).start()

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
