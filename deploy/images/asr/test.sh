#!/usr/bin/env bash
# Container test of the asr image (PLAN P32-01). Run on the devbox, NOT in CI (the image is about 1.4 GB on disk and the model needs CPU).
#
#   bash deploy/images/asr/test.sh                      builds nothing: starts a container of $ASR_IMAGE, runs the cases, removes the container
#   ASR_URL=http://127.0.0.1:8000 bash .../test.sh      runs against a container that already runs (it is left alone; the non-root check is skipped)
#
#   ASR_IMAGE  the image to test (default manythreads/asr:p32-dev; set it to the tag you built); it is also the source of ffmpeg for making the test clips
#   ASR_THREADS  threads for the container this script starts (default 4)
#
# Needs: docker, curl, python3. Heavy: hold the devbox lock (flock) when other jobs may run. Prints one line per case and exits 1 if any failed.
# Test audio: e2e/fixtures/speech/nadia.wav (real English speech; hello.wav is a synthetic buzz, not speech, so only its shape is checked).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/../../../e2e/fixtures/speech"
IMAGE="${ASR_IMAGE:-manythreads/asr:p32-dev}"
WORK="$(mktemp -d)"
NAME="asr-test-$$"
FAILS=0
STARTED=0

cleanup() {
  [ "$STARTED" = 1 ] && docker rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
# check "name" "detail" <command that must succeed>
check() { local name="$1" detail="$2"; shift 2; if "$@"; then pass "$name"; else fail "$name" "$detail"; fi; }

ff() { docker run --rm --user "$(id -u):$(id -g)" --entrypoint ffmpeg -v "$WORK:/w" -v "$(cd "$FIX" && pwd):/f:ro" "$IMAGE" -nostdin -v error -y "$@"; }

if [ -z "${ASR_URL:-}" ]; then
  docker run -d --name "$NAME" -p 127.0.0.1::8000 -e ASR_THREADS="${ASR_THREADS:-4}" "$IMAGE" >/dev/null || { echo "cannot start $IMAGE"; exit 1; }
  STARTED=1
  PORT="$(docker port "$NAME" 8000/tcp | head -1 | sed 's/.*://')"
  URL="http://127.0.0.1:$PORT"
else
  URL="${ASR_URL%/}"
fi

for _ in $(seq 1 120); do
  curl -sf -m 2 "$URL/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 2 "$URL/health" >/dev/null || { echo "the server did not come up at $URL"; exit 1; }
echo "server up at $URL (image $IMAGE)"

# ---- test clips (made from the fixtures with the image's own ffmpeg) ----
ff -i /f/nadia.wav -i /f/rafi.wav -i /f/nadia.wav -filter_complex "concat=n=3:v=0:a=1" -ar 16000 -ac 1 /w/long.wav || { echo "ffmpeg failed"; exit 1; }
ff -i /f/nadia.wav -c:a libopus -b:a 24k /w/nadia.webm
ff -i /f/nadia.wav -c:a aac -b:a 48k /w/nadia-moovend.mp4                      # the mp4 muxer writes the index (moov) last
ff -i /f/nadia.wav -c:a aac -b:a 48k -movflags +faststart /w/nadia-faststart.mp4
# 20 s of speech that does not loop: nadia, rafi, nadia, rafi, each followed by 0.5 s of silence, cut at 20 s (16 kHz mono PCM). Parakeet without the VAD returned an empty text for it.
ff -i /f/nadia.wav -i /f/rafi.wav -i /f/nadia.wav -i /f/rafi.wav -filter_complex "[0:a]apad=pad_dur=0.5[a0];[1:a]apad=pad_dur=0.5[a1];[2:a]apad=pad_dur=0.5[a2];[3:a]apad=pad_dur=0.5[a3];[a0][a1][a2][a3]concat=n=4:v=0:a=1" -t 20 -ar 16000 -ac 1 -c:a pcm_s16le /w/speech20.wav || { echo "ffmpeg failed"; exit 1; }
ff -t 25 -i /w/long.wav -c:a libopus -b:a 24k /w/long25.webm
ff -t 25 -i /w/long.wav /w/long25.wav
ff -i /w/long.wav -i /w/long.wav -filter_complex "concat=n=2:v=0:a=1" -t 40 /w/long40.wav
ff -f lavfi -i "anullsrc=r=16000:cl=mono" -t 262 /w/silence-8mib.wav            # just under 8 MiB
ff -f lavfi -i "anullsrc=r=16000:cl=mono" -t 20 -c:a libopus -b:a 24k /w/silence.webm
python3 -I - "$WORK" <<'PY'
import sys
w = sys.argv[1]
open(f"{w}/over.wav", "wb").write(b"RIFF\0\0\0\0WAVE" + bytes(8 * 1024 * 1024 + 1 - 12))   # exactly 8 MiB + 1 bytes
open(f"{w}/notaudio.bin", "wb").write(b"#EXTM3U\n#EXTINF:1,\n/etc/passwd\n")                # a playlist: must never be opened
PY

# post <file> [extra curl args...]  -> $WORK/code (status), $WORK/body, $WORK/time (seconds)
post() {
  local f="$1"; shift
  curl -s -m 120 -o "$WORK/body" -w '%{http_code} %{time_total}' -F "file=@$f" -F model=whisper-1 "$@" "$URL/v1/audio/transcriptions" > "$WORK/code_time"
  read -r CODE TIME < "$WORK/code_time"
}
# jget <key>  -> value of a top-level key of $WORK/body (json null prints "null")
jget() { python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(json.dumps(v) if v is None or isinstance(v,(int,float)) else v)' "$WORK/body" "$1"; }
# words_found <min> <word...>: at least <min> of the words are in the body text
words_found() {
  local min="$1"; shift
  python3 -I -c 'import json,sys; t=json.load(open(sys.argv[1]))["text"].lower(); n=sum(w in t for w in sys.argv[3:]); print(n, file=sys.stderr); sys.exit(0 if n>=int(sys.argv[2]) else 1)' "$WORK/body" "$min" "$@" 2>/dev/null
}
near() { python3 -I -c 'import sys; sys.exit(0 if abs(float(sys.argv[1])-float(sys.argv[2]))<=float(sys.argv[3]) else 1)' "$1" "$2" "$3"; }
NADIA="contestants twenties undisturbed rest nights dormitories quiet death"
RAFI="kaliko gong pounded ruggedo answered summons"

# ---- 1. /health answers while a clip is being worked on ----
( curl -s -m 120 -o "$WORK/bg_body" -w '%{http_code}' -F "file=@$WORK/long40.wav" -F model=whisper-1 "$URL/v1/audio/transcriptions" > "$WORK/bg_code"; date +%s.%N > "$WORK/bg_done" ) &
BG=$!
sleep 0.5
HEALTH_OK=0; HEALTH_SLOW=0
while [ ! -f "$WORK/bg_done" ]; do
  t=$(curl -s -m 5 -o /dev/null -w '%{http_code} %{time_total}' "$URL/health")
  if [ "${t%% *}" = 200 ]; then HEALTH_OK=$((HEALTH_OK + 1)); else HEALTH_SLOW=$((HEALTH_SLOW + 1)); fi
  near "${t##* }" 0 0.5 || HEALTH_SLOW=$((HEALTH_SLOW + 1))
  [ -f "$WORK/bg_done" ] || sleep 0.1
done
wait "$BG"
check "/health answers (200, under 0.5 s) while a clip runs" "ok=$HEALTH_OK bad=$HEALTH_SLOW" test "$HEALTH_OK" -ge 3 -a "$HEALTH_SLOW" -eq 0
check "the clip that ran during those health checks finished with 200" "code=$(cat "$WORK/bg_code")" test "$(cat "$WORK/bg_code")" = 200

# ---- 2. /v1/models ----
curl -s -m 5 -o "$WORK/body" "$URL/v1/models"
check "/v1/models lists nemo-parakeet-tdt-0.6b-v3" "$(head -c 200 "$WORK/body")" grep -q '"nemo-parakeet-tdt-0.6b-v3"' "$WORK/body"

# ---- 3. words ----
post "$FIX/nadia.wav"; ok=0; [ "$CODE" = 200 ] && words_found 6 $NADIA && ok=1
check "nadia.wav (WAV): at least 6 of 8 reference words, duration 8.6" "code=$CODE $(head -c 300 "$WORK/body")" test "$ok" = 1 -a "$(near "$(jget duration)" 8.62 0.1 && echo y)" = y
post "$FIX/hello.wav"
check "hello.wav (a synthetic buzz, not speech): 200 and duration 6, the words are not checked" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 200 -a "$(near "$(jget duration)" 6 0.1 && echo y)" = y
post "$WORK/nadia.webm"; ok=0; [ "$CODE" = 200 ] && words_found 6 $NADIA && ok=1
check "webm/opus clip gives the expected words" "code=$CODE $(head -c 300 "$WORK/body")" test "$ok" = 1

post "$WORK/speech20.wav"; ok=0; [ "$CODE" = 200 ] && words_found 3 $NADIA && words_found 3 $RAFI && ok=1
check "20 s of speech (nadia, rafi, nadia, rafi with pauses): at least 3 words of nadia AND 3 of rafi (empty without the VAD), took ${TIME}s" "code=$CODE time=$TIME $(head -c 500 "$WORK/body")" test "$ok" = 1
echo "      20 s speech clip: $TIME s, text: $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("text","")[:400])' "$WORK/body")"

# ---- 4. the answer's shape; model and language are ignored ----
post "$WORK/nadia.webm" -F model=anything-at-all -F language=xx -F response_format=verbose_json -F temperature=0.2
check "any model, a language and verbose_json: {text, language: null, duration}" "code=$CODE $(head -c 300 "$WORK/body")" \
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if sorted(d)==["duration","language","text"] and d["language"] is None and isinstance(d["text"],str) else 1)' "$WORK/body"

# ---- 5. the cut rule ----
post "$WORK/long25.webm"
check "a 25 s webm returns duration 20" "code=$CODE duration=$(jget duration)" test "$CODE" = 200 -a "$(near "$(jget duration)" 20 0.05 && echo y)" = y
post "$WORK/long25.wav"
check "a 25 s WAV is cut at 30 s, not 20 (duration 24.8)" "code=$CODE duration=$(jget duration)" test "$CODE" = 200 -a "$(near "$(jget duration)" 24.76 0.1 && echo y)" = y
post "$WORK/long40.wav"
check "a 40 s WAV is cut at 30 s" "code=$CODE duration=$(jget duration)" test "$CODE" = 200 -a "$(near "$(jget duration)" 30 0.05 && echo y)" = y

# ---- 6. mp4 with the index at the end ----
python3 -I - "$WORK/nadia-moovend.mp4" "$WORK/nadia-faststart.mp4" <<'PY' || { echo "FAIL  the test clip is not an mp4 with moov last"; FAILS=$((FAILS + 1)); }
import struct, sys
def atoms(p):
    b = open(p, "rb").read(); o = 0; a = []
    while o < len(b):
        s, t = struct.unpack(">I4s", b[o:o + 8]); a.append(t.decode()); o += s
    return a
end, fast = atoms(sys.argv[1]), atoms(sys.argv[2])
sys.exit(0 if end.index("moov") > end.index("mdat") and fast.index("moov") < fast.index("mdat") else 1)
PY
post "$WORK/nadia-moovend.mp4"; ok=0; [ "$CODE" = 200 ] && words_found 6 $NADIA && ok=1
check "an mp4 with the index (moov) at the end decodes and gives the words" "code=$CODE $(head -c 300 "$WORK/body")" test "$ok" = 1
post "$WORK/nadia-faststart.mp4"; ok=0; [ "$CODE" = 200 ] && words_found 6 $NADIA && ok=1
check "an mp4 with the index first decodes and gives the words" "code=$CODE $(head -c 300 "$WORK/body")" test "$ok" = 1

# ---- 7. limits and refusals ----
post "$WORK/silence-8mib.wav"
check "a file just under 8 MiB is accepted (silence: empty text, duration 30)" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 200 -a "$(jget text)" = "" -a "$(near "$(jget duration)" 30 0.05 && echo y)" = y
post "$WORK/over.wav"
check "8 MiB + 1 is refused (413)" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 413
post "$WORK/nadia.webm" -H "Transfer-Encoding: chunked"
ok=0; [ "$CODE" = 200 ] && words_found 6 $NADIA && ok=1
check "a chunked upload (no Content-Length) works" "code=$CODE $(head -c 200 "$WORK/body")" test "$ok" = 1
post "$WORK/over.wav" -H "Transfer-Encoding: chunked"
check "8 MiB + 1 as a chunked upload is refused (413)" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 413
post "$WORK/silence.webm"
check "silence gives empty text and duration 20" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 200 -a "$(jget text)" = "" -a "$(near "$(jget duration)" 20 0.05 && echo y)" = y
post "$WORK/notaudio.bin"
check "a playlist or other non-audio file is refused (400), never opened" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 400
touch "$WORK/empty"
post "$WORK/empty"
check "an empty file is refused (400)" "code=$CODE $(head -c 200 "$WORK/body")" test "$CODE" = 400
for i in 1 2 3; do
  ( curl -s -m 120 -o "$WORK/c$i.body" -w '%{http_code}' -F "file=@$WORK/long40.wav" -F model=whisper-1 "$URL/v1/audio/transcriptions" > "$WORK/c$i.code" ) &
done
wait
CODES="$(printf '%s\n' "$(cat "$WORK"/c1.code)" "$(cat "$WORK"/c2.code)" "$(cat "$WORK"/c3.code)" | sort | tr '\n' ' ')"
check "three requests at once: two are served, the third gets 429" "codes: $CODES" test "$CODES" = "200 200 429 "
check "the 429 body is an OpenAI-style error" "$(cat "$WORK"/c?.body | grep -a rate_limit | head -c 200)" grep -qa '"rate_limit_error"' "$WORK/c1.body" "$WORK/c2.body" "$WORK/c3.body"
post "$WORK/nadia.webm"
check "after the 429 the server serves again (nothing leaked)" "code=$CODE" test "$CODE" = 200
# an upload that starts and then stalls holds a connection but no slot: two real clips are both served while it hangs
python3 -I - "$URL" 25 <<'PY' &
import socket, sys, time, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
s = socket.create_connection((u.hostname, u.port or 80))
s.sendall(b"POST /v1/audio/transcriptions HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=b\r\nContent-Length: 1000000\r\n\r\n--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n\r\nRIFF")
time.sleep(float(sys.argv[2]))
PY
STALL=$!
sleep 1
for i in 1 2; do
  ( curl -s -m 120 -o "$WORK/s$i.body" -w '%{http_code}' -F "file=@$WORK/long40.wav" -F model=whisper-1 "$URL/v1/audio/transcriptions" > "$WORK/s$i.code" ) &
done
for j in $(jobs -p); do [ "$j" = "$STALL" ] || wait "$j"; done
check "a stalled upload holds no slot: two clips at once are both served meanwhile" "codes: $(cat "$WORK/s1.code") $(cat "$WORK/s2.code")" test "$(cat "$WORK/s1.code")$(cat "$WORK/s2.code")" = 200200
kill "$STALL" 2>/dev/null; wait "$STALL" 2>/dev/null

# ---- 8. the container itself ----
if [ "$STARTED" = 1 ]; then
  check "the server runs as a non-root user" "uid=$(docker exec "$NAME" id -u)" test "$(docker exec "$NAME" id -u)" != 0
  check "HF_HUB_OFFLINE=1 in the container" "" test "$(docker exec "$NAME" printenv HF_HUB_OFFLINE)" = 1
  check "the NOTICE file is in the image" "" docker exec "$NAME" test -s /app/NOTICE
  LEFT="$(docker exec "$NAME" sh -c 'ls /dev/shm | grep -c "^asr-"' 2>/dev/null)"
  check "no clip is left behind in /dev/shm after the cases" "left=$LEFT" test "${LEFT:-1}" = 0
fi

echo
# P35-06: the knowledge embeddings. 768 numbers per text; a sentence is nearer its paraphrase than an unrelated one; a bad input is refused.
EMB="$(curl -s -X POST "$URL/v1/embeddings" -H 'content-type: application/json' -d '{"model":"x","input":["The deploy failed because the disk was full.","Deploying stopped: no space left on the disk.","My cat likes warm milk."]}')"
check "embeddings: three vectors of 768" "$(printf '%s' "$EMB" | head -c 200)" python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); assert len(d["data"])==3 and all(len(x["embedding"])==768 for x in d["data"])' "$EMB"
check "embeddings: a paraphrase is nearer than an unrelated sentence" "cosines" python3 -I -c '
import json,math,sys
v=[x["embedding"] for x in json.loads(sys.argv[1])["data"]]
cos=lambda a,b: sum(i*j for i,j in zip(a,b))/(math.sqrt(sum(i*i for i in a))*math.sqrt(sum(j*j for j in b)))
assert cos(v[0],v[1]) > cos(v[0],v[2]) + 0.1, (cos(v[0],v[1]), cos(v[0],v[2]))' "$EMB"
check "embeddings: an input that is not text is refused (400)" "status" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/v1/embeddings" -H 'content-type: application/json' -d '{"input":[1,2]}')" = 400

if [ "$FAILS" = 0 ]; then echo "all cases passed"; else echo "$FAILS case(s) failed"; exit 1; fi
