# Streaming proxy: concurrency limiting and transcoding

Both features are **opt-in** (default off). With flags unset, IPTVo returns provider URLs directly as before.

Requires **ffmpeg** on the host (included in the official Docker image) and **Redis** for session and job tracking.

## Phase 1 — Per-user concurrency limiting

When `CONCURRENCY_LIMIT_ENABLED=true`, each stream is HLS-relayed so the server can count sessions per user and enforce a provider limit configured in the dashboard (`providerConcurrencyLimit`; `0` = unlimited).

### Behavior

1. Under the limit: create a session, ffmpeg remuxes (`-c copy`) to HLS under `cache/hls/{sessionId}/`.
2. At the limit: new play shows a **countdown** video on the same session URL.
3. If the user stays: least-recently-active session is evicted; playback splices to the new channel without a new client URL.
4. If the user leaves during countdown: eviction is cancelled; the original stream keeps playing.
5. Idle reaper cleans abandoned sessions (shorter grace for countdown sessions).

### Environment

```bash
CONCURRENCY_LIMIT_ENABLED=false
CONCURRENCY_EVICTION_COUNTDOWN_MS=15000
CONCURRENCY_SESSION_IDLE_TIMEOUT_MS=45000
```

### Implementation notes

- Redis: `sessions:{userId}` sorted set (score = last activity) + `session:{sessionId}` hash.
- Atomic slot reserve via Lua (`reserveSessionSlot`); eviction claim via `HSETNX`.
- Internal ABR ladder sessions can be created with `countTowardLimit: false` so they do not consume the provider slot.
- Relay routes validate UUID session ids, check ownership, rate-limit, and resolve paths with base-directory containment.
- Bandwidth: all limited streams pass through your server (not direct provider CDN).

## Phase 2 — Optional ABR transcoding

When `TRANSCODE_ENABLED=true` (independent of concurrency limiting), the server can expose a master playlist and encode selected heights.

### Environment

```bash
TRANSCODE_ENABLED=false
TRANSCODE_RENDITIONS=1080,720,480,360
TRANSCODE_CODEC=h264          # h264 | hevc | av1
TRANSCODE_HWACCEL=none        # none | nvenc | qsv | vaapi
TRANSCODE_VAAPI_DEVICE=/dev/dri/renderD128
TRANSCODE_CRF=23
TRANSCODE_PRESET=veryfast
TRANSCODE_MAX_CONCURRENT_JOBS=2
```

### Behavior

- Master route builds an HLS multivariant playlist (source + configured heights).
- Encode args live in `src/transcodeConfig.js` (scale / tone-map, encoder, rate control).
- **HDR**: ffprobe `color_transfer`; `smpte2084` (PQ) and `arib-std-b67` (HLG) preserved on hevc/av1; h264 uses a tone-map chain to SDR.
- **VAAPI**: `-vaapi_device`, `format=nv12,scale,hwupload` on VAAPI filter graphs.
- **SVT-AV1**: software preset names map to numeric SVT presets; vaapi+av1 falls back to `libsvtav1`.
- **Global encode cap**: Redis key `transcode:activeJobs` (INCR/DECR); in-process counter if Redis is unavailable.

### Resource notes

- Software encodes are CPU-heavy; keep `TRANSCODE_MAX_CONCURRENT_JOBS` low on small hosts.
- Hardware paths need working drivers/devices inside the container (e.g. device mounts for `/dev/dri`).

## Docker Compose

The app service should receive `CONCURRENCY_*` and `TRANSCODE_*` variables and a writable volume for `cache` (HLS segments and posters). See root `docker-compose.yml` and `.env.example`.

## Related modules

| Module | Role |
|--------|------|
| `src/streamSessions.js` | Redis session lifecycle, reserve, reaper |
| `src/streamRelay.js` | ffmpeg remux / encode / countdown processes |
| `src/transcodeConfig.js` | Encoder CLI args for one rendition |
| `server.js` | Stream selection, master + relay HTTP routes |
