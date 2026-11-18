"""The speech-to-text server (PLAN D13, docs/deploy.md "Speech to text").

An OpenAI-compatible subset on top of NVIDIA Parakeet TDT 0.6B v3 (int8, CPU, through onnx-asr):

  GET  /health                     answers at once, also while a clip is being worked on
  GET  /v1/models
  POST /v1/audio/transcriptions    multipart `file`; any `model` is accepted and `language` is ignored

The LLM gateway runs with drop_params, so no extra form field reaches this pod; the cut is decided from the input type instead:
  - input that is not WAV (a voice clip from a browser) is cut at 20 seconds;
  - WAV input (meeting chunks, at most 30 seconds) is cut at 30 seconds.
Only one clip is recognised at a time. One more may wait; a third gets 429 and the caller retries later.
"""

import asyncio
import logging
import os
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import numpy as np
import onnxruntime as ort
import onnx_asr
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

MODEL_NAME = "nemo-parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16000
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
# The multipart envelope (boundary lines, field names, the other form fields) around the 8 MiB file.
ENVELOPE_BYTES = 64 * 1024
CUT_SECONDS = 20.0
CUT_SECONDS_WAV = 30.0
# One clip runs and one may wait.
MAX_IN_FLIGHT = 2
DECODE_TIMEOUT_S = 30
SHM = "/dev/shm"

log = logging.getLogger("asr")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper(), format="%(asctime)s %(levelname)s %(message)s")

# What ffmpeg may open: only the container formats a browser or a meeting chunk can produce, named by their first bytes.
# The name goes to `-f`, so a text file that pretends to be a playlist is never opened as one.
def sniff(head: bytes) -> tuple[str, bool] | None:
    """(ffmpeg demuxer name, is WAV) from the first bytes, or None when the type is not one we accept."""
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav", True
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "matroska", False  # webm and mkv
    if head[:4] == b"OggS":
        return "ogg", False
    if head[4:8] == b"ftyp":
        return "mov", False  # mp4, m4a, 3gp
    if head[:4] == b"fLaC":
        return "flac", False
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0 and head[1] & 0x06 != 0x00):
        # An ADTS AAC frame has layer bits 00; an MP3 frame has layer 01, 10 or 11.
        return "mp3", False
    if len(head) > 1 and head[0] == 0xFF and head[1] & 0xF6 == 0xF0:
        return "aac", False
    return None


def threads() -> int:
    try:
        return max(1, int(os.environ.get("ASR_THREADS", "4")))
    except ValueError:
        return 4


state: dict = {"model": None, "in_flight": 0}
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="recognize")
slot = asyncio.Semaphore(1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads()
    opts.inter_op_num_threads = 1
    started = time.monotonic()
    state["model"] = onnx_asr.load_model(MODEL_NAME, quantization="int8", sess_options=opts)
    log.info("model %s loaded in %.1fs, %d threads", MODEL_NAME, time.monotonic() - started, threads())
    yield


app = FastAPI(title="manythreads asr", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class BodyLimit:
    """Stops a request body at 8 MiB plus the multipart envelope, as declared (Content-Length) or as received (chunked uploads have no length)."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        limit = MAX_UPLOAD_BYTES + ENVELOPE_BYTES
        declared = dict(scope["headers"]).get(b"content-length", b"0")
        if not declared.isdigit() or int(declared) > limit:
            response = error(413, "The audio is larger than 8 MiB.")
            return await response(scope, receive, send)
        seen = 0

        async def counted():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise HTTPException(413, "The audio is larger than 8 MiB.")
            return message

        await self.inner(scope, counted, send)


app.add_middleware(BodyLimit)


def error(status: int, message: str, kind: str = "invalid_request_error") -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": kind, "code": status}}, status_code=status)


@app.exception_handler(StarletteHTTPException)
async def http_error(_request: Request, exc: StarletteHTTPException):
    kind = "rate_limit_error" if exc.status_code == 429 else "invalid_request_error"
    return JSONResponse(
        {"error": {"message": str(exc.detail), "type": kind, "code": exc.status_code}},
        status_code=exc.status_code,
        headers=getattr(exc, "headers", None),
    )


@app.get("/health")
async def health():
    return {"status": "ok" if state["model"] is not None else "loading"}


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "nvidia"}]}


async def decode(path: str, demuxer: str, cut: float) -> np.ndarray:
    """ffmpeg: the first `cut` seconds as 16 kHz mono float32."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-protocol_whitelist", "file",
        "-t", f"{cut}", "-f", demuxer, "-i", path,
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )  # fmt: skip
    try:
        out, err = await asyncio.wait_for(proc.communicate(), DECODE_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(400, "The audio took too long to decode.")
    if proc.returncode != 0:
        log.info("ffmpeg refused a clip: %s", err.decode("utf-8", "replace")[:200])
        raise HTTPException(400, "The audio could not be decoded.")
    samples = np.frombuffer(out[: len(out) // 2 * 2], dtype="<i2")
    return samples.astype(np.float32) / 32768.0


def recognize(audio: np.ndarray) -> str:
    return str(state["model"].recognize(audio, sample_rate=SAMPLE_RATE)).strip()


@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request):
    if state["model"] is None:
        return error(503, "The model is still loading.", "server_error")
    if state["in_flight"] >= MAX_IN_FLIGHT:
        raise HTTPException(429, "The speech server is busy. Try again in a moment.", headers={"Retry-After": "5"})
    state["in_flight"] += 1
    path = None
    try:
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(400, "A `file` field is required.")
        data = await upload.read()
        response_format = str(form.get("response_format") or "json")
        await form.close()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "The audio is larger than 8 MiB.")
        if not data:
            raise HTTPException(400, "The audio is empty.")
        kind = sniff(data[:12])
        if kind is None:
            raise HTTPException(400, "The audio type is not supported.")
        demuxer, is_wav = kind
        cut = CUT_SECONDS_WAV if is_wav else CUT_SECONDS
        # tmpfs, not a pipe: an mp4 written with its index at the end can only be read from a file.
        path = os.path.join(SHM, f"asr-{uuid.uuid4().hex}")
        with open(path, "wb") as f:
            f.write(data)
        del data
        async with slot:
            started = time.monotonic()
            audio = await decode(path, demuxer, cut)
            decoded = time.monotonic()
            if len(audio) < SAMPLE_RATE // 10:
                text = ""  # under a tenth of a second: nothing to recognise
            else:
                text = await asyncio.get_running_loop().run_in_executor(executor, recognize, audio)
            log.info("clip %.2fs: decode %.2fs, recognise %.2fs", len(audio) / SAMPLE_RATE, decoded - started, time.monotonic() - decoded)
        seconds = round(len(audio) / SAMPLE_RATE, 3)
        if response_format == "text":
            return PlainTextResponse(text)
        return {"text": text, "language": None, "duration": seconds}
    finally:
        state["in_flight"] -= 1
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
