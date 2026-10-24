FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Model is baked into the image, so processing never downloads user media or models.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', revision='536b0662742c02347bc0e980a01041f333bce120', local_dir='/models/small')"
COPY worker.py job_events.py .
ENV DATA_ROOT=/app/storage WHISPER_MODEL_PATH=/models/small HF_HUB_OFFLINE=1
USER 10001:10001
CMD ["python", "worker.py"]
