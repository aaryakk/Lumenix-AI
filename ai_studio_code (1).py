import base64, io, os, re, subprocess, threading, time, uuid
from typing import List, Optional
import torch
from PIL import Image
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from diffusers import LTXPipeline, LTXImageToVideoPipeline
from diffusers.utils import export_to_video
import uvicorn

VIDEO_API_SECRET = "CHANGE_THIS_TO_YOUR_SECRET_PASSWORD"
JOBS_DIR = "/tmp/lumenix_jobs"
os.makedirs(JOBS_DIR, exist_ok=True)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Load LTX-Video with CPU offloading for free 15GB–16GB T4 GPUs
print("Loading LTX-Video T2V & I2V pipelines...")
t2v_pipe = LTXPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=torch.bfloat16)
t2v_pipe.enable_model_cpu_offload()

i2v_pipe = LTXImageToVideoPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=torch.bfloat16)
i2v_pipe.enable_model_cpu_offload()
print("Models ready!")

JOBS = {}  # In-memory job tracker

def verify_secret(x_lumenix_secret: Optional[str]):
    if VIDEO_API_SECRET and x_lumenix_secret != VIDEO_API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid X-Lumenix-Secret")

def get_dims(aspect_ratio: str):
    # (ltx_width, ltx_height, final_even_width, final_even_height)
    return {
        "9:16": (480, 864, 480, 854),
        "16:9": (704, 416, 704, 396),
        "1:1":  (512, 512, 512, 512),
    }.get(aspect_ratio, (480, 864, 480, 854))

def extract_last_frame_b64(mp4_path: str) -> Optional[str]:
    img_path = mp4_path + "_last.png"
    subprocess.run(["ffmpeg", "-y", "-sseof", "-0.1", "-i", mp4_path, "-vframes", "1", img_path],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(img_path):
        with open(img_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        os.remove(img_path)
        return f"data:image/png;base64,{b64}"
    return None

class ShotRequest(BaseModel):
    mode: str = "text-to-video"
    prompt: str
    aspectRatio: str = "9:16"
    frames: int = 73  # 49 (~2s), 73 (~3s), 97 (~4s)
    image: Optional[str] = None

class StitchRequest(BaseModel):
    shotIds: List[str]
    transition: str = "fade"  # fade, wipeleft, slideup, circleopen
    subtitles: List[str] = []
    voiceoverText: Optional[str] = None
    voiceoverAudioBase64: Optional[str] = None
    musicAudioBase64: Optional[str] = None
    aspectRatio: str = "9:16"

@app.get("/health")
def health():
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
    vram_free = round(torch.cuda.mem_get_info()[0] / (1024**3), 2) if torch.cuda.is_available() else 0
    active = sum(1 for j in JOBS.values() if j["status"] in ("queued", "running"))
    return {
        "online": True,
        "model": "Lightricks/LTX-Video",
        "gpu": gpu_name,
        "vramFreeGb": vram_free,
        "activeJobs": active,
    }

def process_shot_job(job_id: str, req: ShotRequest):
    try:
        JOBS[job_id]["status"] = "running"
        JOBS[job_id]["progress"] = "Preparing LTX-Video latent space..."
        ltx_w, ltx_h, out_w, out_h = get_dims(req.aspectRatio)

        # Snap frames strictly to LTX rule: 8*k + 1 within 49..97 (2s..4s @ 24fps)
        valid_frames = min(97, max(49, ((req.frames - 1) // 8) * 8 + 1))
        raw_mp4 = os.path.join(JOBS_DIR, f"{job_id}_raw.mp4")
        final_mp4 = os.path.join(JOBS_DIR, f"{job_id}.mp4")

        JOBS[job_id]["progress"] = f"Rendering {valid_frames} frames ({ltx_w}x{ltx_h})..."
        if req.mode == "image-to-video" and req.image:
            b64 = req.image.split(",", 1)[1] if "," in req.image else req.image
            init_img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB").resize((ltx_w, ltx_h))
            frames = i2v_pipe(
                image=init_img,
                prompt=req.prompt,
                negative_prompt="blurry, distorted, low quality, flickering, deformed",
                width=ltx_w,
                height=ltx_h,
                num_frames=valid_frames,
                num_inference_steps=28,
            ).frames[0]
        else:
            frames = t2v_pipe(
                prompt=req.prompt,
                negative_prompt="blurry, distorted, low quality, flickering, deformed",
                width=ltx_w,
                height=ltx_h,
                num_frames=valid_frames,
                num_inference_steps=28,
            ).frames[0]

        export_to_video(frames, raw_mp4, fps=24)

        # Normalize to exact requested output size & H.264 24fps
        subprocess.run([
            "ffmpeg", "-y", "-i", raw_mp4,
            "-vf", f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},fps=24",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", final_mp4
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(raw_mp4)

        last_frame = extract_last_frame_b64(final_mp4)
        JOBS[job_id]["status"] = "completed"
        JOBS[job_id]["progress"] = "Done"
        JOBS[job_id]["durationSec"] = round(valid_frames / 24, 2)
        JOBS[job_id]["lastFrame"] = last_frame
    except Exception as e:
        JOBS[job_id]["status"] = "failed"
        JOBS[job_id]["error"] = str(e)

@app.post("/jobs/start")
def start_job(req: ShotRequest, x_lumenix_secret: Optional[str] = Header(default=None)):
    verify_secret(x_lumenix_secret)
    job_id = str(uuid.uuid4())[:12]
    JOBS[job_id] = {"status": "queued", "progress": "Queued on GPU", "error": None}
    threading.Thread(target=process_shot_job, args=(job_id, req), daemon=True).start()
    return {"jobId": job_id}

@app.get("/jobs/status/{job_id}")
def job_status(job_id: str, x_lumenix_secret: Optional[str] = Header(default=None)):
    verify_secret(x_lumenix_secret)
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    return JOBS[job_id]

@app.post("/stitch")
def stitch_shots(req: StitchRequest, x_lumenix_secret: Optional[str] = Header(default=None)):
    verify_secret(x_lumenix_secret)
    if len(req.shotIds) == 0:
        raise HTTPException(status_code=400, detail="No shotIds provided")

    inputs = [os.path.join(JOBS_DIR, f"{sid}.mp4") for sid in req.shotIds]
    for p in inputs:
        if not os.path.exists(p):
            raise HTTPException(status_code=404, detail=f"Shot file missing: {p}")

    out_id = f"final_{str(uuid.uuid4())[:10]}"
    stitched_no_audio = os.path.join(JOBS_DIR, f"{out_id}_video.mp4")
    final_out = os.path.join(JOBS_DIR, f"{out_id}.mp4")

    # 1. Stitch 1..5 clips with xfade transitions
    if len(inputs) == 1:
        subprocess.run(["cp", inputs[0], stitched_no_audio], check=True)
        total_dur = JOBS.get(req.shotIds[0], {}).get("durationSec", 3.0)
    else:
        cmd = ["ffmpeg", "-y"]
        for p in inputs:
            cmd.extend(["-i", p])

        xfade_dur = 0.4
        filter_parts = []
        cum_dur = JOBS.get(req.shotIds[0], {}).get("durationSec", 3.0)
        prev_label = "[0:v]"
        for idx in range(1, len(inputs)):
            offset = max(0.2, round(cum_dur - xfade_dur, 2))
            out_label = f"[v{idx}]" if idx < len(inputs) - 1 else "[vout]"
            filter_parts.append(
                f"{prev_label}[{idx}:v]xfade=transition={req.transition}:duration={xfade_dur}:offset={offset}{out_label}"
            )
            prev_label = out_label
            next_dur = JOBS.get(req.shotIds[idx], {}).get("durationSec", 3.0)
            cum_dur = offset + next_dur
        total_dur = cum_dur

        cmd.extend(["-filter_complex", ";".join(filter_parts), "-map", "[vout]",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", stitched_no_audio])
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 2. Burn subtitles if provided
    sub_video = stitched_no_audio
    if any(s.strip() for s in req.subtitles):
        srt_path = os.path.join(JOBS_DIR, f"{out_id}.srt")
        t_cursor = 0.0
        with open(srt_path, "w", encoding="utf-8") as srt:
            for i, sid in enumerate(req.shotIds):
                dur = JOBS.get(sid, {}).get("durationSec", 3.0)
                text = req.subtitles[i].strip() if i < len(req.subtitles) else ""
                if text:
                    def fmt(sec):
                        h, r = divmod(sec, 3600)
                        m, s = divmod(r, 60)
                        return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int((s%1)*1000):03d}"
                    srt.write(f"{i+1}\n{fmt(t_cursor)} --> {fmt(t_cursor + dur - 0.1)}\n{text}\n\n")
                t_cursor += max(0.5, dur - (0.4 if i > 0 else 0))

        sub_out = os.path.join(JOBS_DIR, f"{out_id}_sub.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-i", stitched_no_audio,
            "-vf", f"subtitles={srt_path}:force_style='FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2'",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", sub_out
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sub_video = sub_out

    # 3. Prepare Voiceover (Uploaded Audio OR Free Open-Source Piper TTS) & Background Music
    vo_path = None
    if req.voiceoverAudioBase64:
        b64 = req.voiceoverAudioBase64.split(",", 1)[1] if "," in req.voiceoverAudioBase64 else req.voiceoverAudioBase64
        vo_path = os.path.join(JOBS_DIR, f"{out_id}_vo.audio")
        with open(vo_path, "wb") as f:
            f.write(base64.b64decode(b64))
    elif req.voiceoverText and req.voiceoverText.strip():
        vo_wav = os.path.join(JOBS_DIR, f"{out_id}_vo.wav")
        p = subprocess.run(
            ["piper", "--model", "/tmp/piper_voices/en_US-lessac-medium.onnx", "--output_file", vo_wav],
            input=req.voiceoverText.strip(), text=True
        )
        if p.returncode == 0 and os.path.exists(vo_wav):
            vo_path = vo_wav

    bg_path = None
    if req.musicAudioBase64:
        b64 = req.musicAudioBase64.split(",", 1)[1] if "," in req.musicAudioBase64 else req.musicAudioBase64
        bg_path = os.path.join(JOBS_DIR, f"{out_id}_bg.audio")
        with open(bg_path, "wb") as f:
            f.write(base64.b64decode(b64))

    # 4. Mux audio tracks into final MP4
    if vo_path and bg_path:
        subprocess.run([
            "ffmpeg", "-y", "-i", sub_video, "-i", vo_path, "-i", bg_path,
            "-filter_complex", "[1:a]volume=1.0[a1];[2:a]volume=0.22[a2];[a1][a2]amix=inputs=2:duration=longest[aout]",
            "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-shortest", final_out
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif vo_path or bg_path:
        a_path = vo_path or bg_path
        vol = "1.0" if vo_path else "0.35"
        subprocess.run([
            "ffmpeg", "-y", "-i", sub_video, "-i", a_path,
            "-filter_complex", f"[1:a]volume={vol}[aout]",
            "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-shortest", final_out
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.run(["cp", sub_video, final_out], check=True)

    return {"finalId": out_id, "durationSec": round(total_dur, 2)}

@app.get("/file/{file_id}")
def get_mp4(file_id: str, x_lumenix_secret: Optional[str] = Header(default=None)):
    verify_secret(x_lumenix_secret)
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", file_id)
    path = os.path.join(JOBS_DIR, f"{safe_id}.mp4")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Video file not found")
    return FileResponse(path, media_type="video/mp4", filename=f"lumenix-{safe_id}.mp4")

threading.Thread(target=lambda: uvicorn.run(app, host="0.0.0.0", port=8000), daemon=True).start()
time.sleep(2)

proc = subprocess.Popen(["./cloudflared", "tunnel", "--url", "http://localhost:8000"],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for line in proc.stdout:
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        print("\n====================================================")
        print("COPY THIS URL INTO CLOUDFLARE WORKER (VIDEO_BACKEND_URL):")
        print(m.group(0))
        print("====================================================\n")