#!/bin/sh
# Select this script (trainertwin-tts-start / 8117) when resuming the JL container.
set -eu

root=/home/tts-prod
backend=/home/tts-l4-benchmark
for file in "$backend/.venv/bin/vllm" "$root/.venv/bin/python" "$root/.env" "$root/deploy/voxcpm2.yaml"; do
    test -f "$file" || { echo "Missing TTS deployment file: $file" >&2; exit 1; }
done

# Close this lock in child processes so they don't prevent later startup attempts.
exec 9>"$root/.startup.lock"
flock -n 9 || { echo "TTS startup already in progress"; exit 0; }
mkdir -p /srv/tts "$root/speakers" "$root/logs"
ln -sfn "$root/voices" /srv/tts/voices
stamp=$(date -u +%Y%m%d-%H%M%S)-$$

new_log() {
    log="$root/logs/$1-$stamp.log"
    if [ -f "$root/$1.log" ] && [ ! -L "$root/$1.log" ]; then
        mv "$root/$1.log" "$root/logs/$1-before-$stamp.log"
    fi
    touch "$log"
    ln -sfn "$log" "$root/$1.log"
}

if ! pgrep -f '[v]llm serve openbmb/VoxCPM2' >/dev/null; then
    new_log backend
    cd "$backend"
    nohup env SPEAKER_SAMPLES_DIR="$root/speakers" HF_HOME=/home/.cache/huggingface \
        TORCHINDUCTOR_CACHE_DIR=/home/.cache/torchinductor TRITON_CACHE_DIR=/home/.cache/triton \
        .venv/bin/vllm serve openbmb/VoxCPM2 --omni --host 127.0.0.1 --port 8001 \
        --deploy-config "$root/deploy/voxcpm2.yaml" --revision 7936080b41163874f38610f46f438e2c0757f9fd \
        > "$root/backend.log" 2>&1 < /dev/null 9>&- &
fi

if ! pgrep -f '[u]vicorn app.main:app' >/dev/null; then
    new_log proxy
    cd "$root"
    nohup .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 \
        --env-file "$root/.env" > "$root/proxy.log" 2>&1 < /dev/null 9>&- &
fi

if [ -f /home/vector-start.sh ] && ! pgrep -f '[v]ector --config /home/tts-prod/vector.yaml' >/dev/null; then
    sh /home/vector-start.sh 9>&-
fi
echo "TTS startup ensured; check /healthz after model warmup"
