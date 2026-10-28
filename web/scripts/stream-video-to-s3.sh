#!/bin/sh
# stream-video-to-s3.sh <url> <dest: file path or s3://bucket/key>: YouTube/Loom video -> merged fragmented MP4
# (<=720p) through named pipes, so nothing is written to disk on the way to S3.
set -u
URL="$1"; DEST="$2"; D=$(mktemp -d /tmp/olgastream.XXXX); mkfifo "$D/v" "$D/a" "$D/out"
F="--no-warnings -q --no-part --no-progress"
yt-dlp $F -f "bv*[height<=720][ext=mp4]/bv*[height<=720]" -o - -- "$URL" > "$D/v" 2>"$D/ev" & PV=$!
yt-dlp $F -f "ba[ext=m4a]/ba" -o - -- "$URL" > "$D/a" 2>"$D/ea" & PA=$!
FF="-nostdin -loglevel error -y -i $D/v -i $D/a -map 0:v:0 -map 1:a:0 -c copy -bsf:a aac_adtstoasc -movflags frag_keyframe+empty_moov -f mp4"
RS=0
if [ "${DEST#s3://}" != "$DEST" ]; then
  aws s3 cp --only-show-errors --content-type video/mp4 - "$DEST" < "$D/out" 2>"$D/es" & PS=$!
  ffmpeg $FF - > "$D/out" 2>"$D/ef"; RF=$?
  wait $PS; RS=$?
else
  ffmpeg $FF "$DEST" 2>"$D/ef"; RF=$?
fi
# If ffmpeg quit early (e.g. a download failed), a yt-dlp may still block on its pipe: stop it.
[ $RF -ne 0 ] && kill $PV $PA 2>/dev/null
wait $PV; RV=$?; wait $PA; RA=$?
cat "$D/ev" "$D/ea" "$D/ef" "$D/es" 2>/dev/null >&2; rm -rf "$D"
[ $RV -eq 0 ] && [ $RA -eq 0 ] && [ $RF -eq 0 ] && [ $RS -eq 0 ]
