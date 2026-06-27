# Video Recording

Capture browser automation sessions as video for debugging, documentation, or verification. Produces WebM (VP8/VP9 codec).

## Basic Recording

```bash
# Start recording
playwright-cli video-start

# Perform actions
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli click e1
playwright-cli fill e2 "test input"

# Stop and save
playwright-cli video-stop demo.webm
```

## Best Practices

### 1. Use Descriptive Filenames

```bash
# Include context in filename
playwright-cli video-stop recordings/login-flow-2024-01-15.webm
playwright-cli video-stop recordings/checkout-test-run-42.webm
```

## Converting WebM to MP4

playwright-cli only records WebM. Some destinations don't accept it — notably **GitHub**, which won't embed WebM inline in comments or PR descriptions. Transcode to MP4 (H.264) with `ffmpeg`:

```bash
ffmpeg -y -i recordings/run.webm \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -movflags +faststart -an \
  recordings/run.mp4
```

- `-c:v libx264 -pix_fmt yuv420p` — the H.264/yuv420p combo every browser, QuickTime, and GitHub can play.
- `-movflags +faststart` — moves the index to the front so the file streams without a full download.
- `-an` — drops audio; playwright recordings have none.

Sanity-check the result before relying on it:

```bash
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name recordings/run.mp4
```

## Tracing vs Video

| Feature | Video | Tracing |
|---------|-------|---------|
| Output | WebM file | Trace file (viewable in Trace Viewer) |
| Shows | Visual recording | DOM snapshots, network, console, actions |
| Use case | Demos, documentation | Debugging, analysis |
| Size | Larger | Smaller |

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
