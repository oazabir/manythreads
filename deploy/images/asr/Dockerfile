# syntax=docker/dockerfile:1
# The speech-to-text server of voice rooms (PLAN P15-07, decision C15; docs/deploy.md "Speech to text"): speaches (MIT), an OpenAI-compatible Whisper server, CPU build,
# with the model baked in so the pod never downloads anything at run time (the air-gapped preset needs the model inside the deployment, and a pod restart must not depend on
# Hugging Face being up). Build once:
#   docker build -t manythreads/asr:<tag> deploy/images/asr                     (tools/devbox/deploy.sh does this when asr.enabled is true in values-live.yaml)
#   docker build --build-arg ASR_MODEL=Systran/faster-whisper-base ...           (a bigger model: better words, slower on a CPU)
# The base is pinned by digest (speaches 0.8.3, linux/amd64 + arm64): a new tag can change the API or the model cache layout. Change it on purpose, then check
# `GET /health` and `GET /v1/models` on the built image (docs/deploy.md "Speech to text").
FROM ghcr.io/speaches-ai/speaches:0.8.3-cpu@sha256:21e3df06d842fb7802ab470dd77c25f0e8c0d22950e8d8c6ae886e851af53ef8
ARG ASR_MODEL=Systran/faster-whisper-tiny
# The only network use of this image: one model download at build time into the Hugging Face cache of the image's user (ubuntu, uid 1000).
ENV ASR_MODEL=${ASR_MODEL}
RUN python -c "import os; from huggingface_hub import snapshot_download; snapshot_download(os.environ['ASR_MODEL'])"
ENV HF_HUB_OFFLINE=1 \
    ENABLE_UI=false \
    LOG_LEVEL=info \
    WHISPER__INFERENCE_DEVICE=cpu \
    WHISPER__COMPUTE_TYPE=int8 \
    WHISPER__TTL=-1
