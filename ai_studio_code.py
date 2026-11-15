!apt-get -qq update && apt-get -qq install -y ffmpeg
!pip install -q diffusers transformers accelerate sentencepiece fastapi uvicorn python-multipart piper-tts
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared
!chmod +x cloudflared

# Download 1 small free open-source Piper voice model (English) for optional auto-voiceover
!mkdir -p /tmp/piper_voices /tmp/lumenix_jobs
!wget -q -O /tmp/piper_voices/en_US-lessac-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
!wget -q -O /tmp/piper_voices/en_US-lessac-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json