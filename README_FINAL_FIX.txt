FINAL FIX — OTKOSK + ICE ARENA

ОТСКОК:
- server-authoritative trajectory is sampled at 120 FPS and sent to the client;
- client no longer runs an independent physics simulation;
- ring rotation is smoothly aligned before launch and stays aligned with authoritative physics;
- final ring angle stays frozen at the real end position;
- multiplier remains exactly bounces * mode step;
- avoids visible tunneling/jitter caused by client/server physics mismatch.

ICE ARENA:
- round timer now matches the original visual animation duration so the game does not freeze at the end;
- redo anomaly timer matches the full two-phase animation;
- puck has a permanent CSS fallback so it remains visible even if the PNG is unavailable;
- client never rewinds animation time because of websocket clock jitter;
- result state forces the visual to the end instead of leaving a dead period.

Other modes were not changed intentionally.
