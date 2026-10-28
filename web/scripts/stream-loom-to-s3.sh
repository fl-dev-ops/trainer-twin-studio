#!/bin/sh
# stream-loom-to-s3.sh <url> <dest: file path or s3://bucket/key>: Loom video -> fragmented MP4 (<=720p), streamed
# straight to S3 (or a file), so the video is never written to disk on the way.
# Loom serves signed HLS (split video+audio, or muxed) or DASH (vp9+opus webm):
# - HLS: segment URLs need the playlist's signature query, which yt-dlp -o - (ffmpeg downloader) drops, so we
#   rewrite the media playlists (tiny text files) and let ffmpeg fetch the segments; remuxed, no transcode.
# - DASH: yt-dlp's native downloader streams each track to a named pipe; transcoded to h264/aac so it plays everywhere.
set -u
URL="$1"; DEST="$2"; D=$(mktemp -d /tmp/olgastream.XXXX); trap 'rm -rf "$D"' EXIT
fail() { cat "$D"/e* 2>/dev/null | tail -20 >&2; echo "stream-loom-to-s3: $1 ($(tail -1 "$D/ef" 2>/dev/null))" >&2; exit 1; }
Y="--no-warnings -q --no-progress"
yt-dlp $Y -f "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b" --print protocol --print format_id --print urls -- "$URL" > "$D/info" 2>"$D/ey" \
  || fail "yt-dlp could not resolve $URL"
PROTO=$(sed -n 1p "$D/info"); FIDS=$(sed -n 2p "$D/info"); PV=""; PA=""
case "$PROTO" in
  m3u8_native|m3u8_native+m3u8_native)
    IN=""; i=0
    tail -n +3 "$D/info" > "$D/urls"
    while read -r U; do
      i=$((i + 1)); Q="${U#*\?}"; B="${U%%\?*}"; B="${B%/*}"
      curl -fsS "$U" 2>>"$D/ec" | awk -v b="$B" -v q="$Q" '/^#/ || /^$/ || /^https?:/ { print; next } { print b "/" $0 "?" q }' > "$D/$i.m3u8"
      grep -q '^#EXTINF' "$D/$i.m3u8" || fail "playlist $i is empty or unreadable"
      IN="$IN -protocol_whitelist file,http,https,tcp,tls,crypto -seg_max_retry 5 -i $D/$i.m3u8"
    done < "$D/urls"
    if [ $i -eq 2 ]; then MAP="-map 0:v:0 -map 1:a:0"; else MAP="-map 0:v:0 -map 0:a:0?"; fi
    CODEC="-c copy -bsf:a aac_adtstoasc" ;;
  http_dash_segments+http_dash_segments)
    mkfifo "$D/v" "$D/a"
    yt-dlp $Y --no-part -N 8 -f "${FIDS%%+*}" -o - -- "$URL" > "$D/v" 2>"$D/ev" & PV=$!
    yt-dlp $Y --no-part -N 8 -f "${FIDS##*+}" -o - -- "$URL" > "$D/a" 2>"$D/ea" & PA=$!
    IN="-i $D/v -i $D/a"; MAP="-map 0:v:0 -map 1:a:0"
    CODEC="-c:v h264_videotoolbox -b:v 1500k -pix_fmt yuv420p -c:a aac -b:a 128k" ;;
  *) fail "unsupported Loom format $FIDS ($PROTO)" ;;
esac
FF="-nostdin -loglevel warning -y $IN $MAP $CODEC -movflags frag_keyframe+empty_moov -f mp4"
RS=0
if [ "${DEST#s3://}" != "$DEST" ]; then
  mkfifo "$D/out"
  aws s3 cp --only-show-errors --content-type video/mp4 - "$DEST" < "$D/out" 2>"$D/es" & PS=$!
  ffmpeg $FF - > "$D/out" 2>"$D/ef"; RF=$?
  wait $PS; RS=$?
else
  ffmpeg $FF "$DEST" 2>"$D/ef"; RF=$?
fi
RV=0; RA=0
[ -n "$PV" ] && { wait $PV; RV=$?; }
[ -n "$PA" ] && { wait $PA; RA=$?; }
[ $RF -eq 0 ] && [ $RS -eq 0 ] && [ $RV -eq 0 ] && [ $RA -eq 0 ] || fail "ffmpeg=$RF aws=$RS yt-dlp=$RV/$RA"
# ffmpeg's HLS reader skips segments it cannot fetch and still exits 0: treat that as a failure.
! grep -qiE 'failed to open segment|error when loading|server returned|http error' "$D/ef" || fail "segment download failed"
