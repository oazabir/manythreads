# syntax=docker/dockerfile:1
# The speech-to-text server (PLAN D13, docs/deploy.md "Speech to text"): NVIDIA Parakeet TDT 0.6B v3 (int8, CPU) through onnx-asr (MIT), behind a small OpenAI-compatible
# server (server.py). The model is downloaded once while the image is built; the pod never downloads anything (HF_HUB_OFFLINE=1), so the air-gapped preset works and a restart does
# not depend on Hugging Face being up. Build:
#   docker build -t manythreads/asr:<tag> deploy/images/asr        (tools/devbox/deploy.sh does this when asr.enabled is true in values-live.yaml)
# Test the built image on the devbox (not in CI; the image is large): see deploy/images/asr/test.sh.
# The base is pinned by digest (python:3.12-slim, multi-arch index) and the Python packages by hash (requirements.txt, made with
#   pip-compile --generate-hashes --allow-unsafe --strip-extras requirements.in
# (requirements.in is kept beside it). Change them on purpose, then run test.sh. Licences: NOTICE.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# Debian's ffmpeg decodes webm/opus, mp4/aac and the rest to raw samples. It is a GPL build: see NOTICE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt

# uid 1000: the chart runs the pod as 1000 (runAsNonRoot).
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin asr
USER asr
ENV HF_HOME=/home/asr/hf
# The only network use of this image besides apt and pip: the int8 model files of istupakov/parakeet-tdt-0.6b-v3-onnx (CC-BY-4.0, NVIDIA's model) into HF_HOME.
RUN python -c "import onnx_asr; onnx_asr.load_model('nemo-parakeet-tdt-0.6b-v3', quantization='int8')" \
 && du -sh /home/asr/hf

WORKDIR /app
COPY --chown=asr:asr server.py NOTICE /app/
ENV HF_HUB_OFFLINE=1 \
    ASR_THREADS=4 \
    LOG_LEVEL=info \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--timeout-keep-alive", "30"]
