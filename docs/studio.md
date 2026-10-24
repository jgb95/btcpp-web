# Studio

Open Studio from an event's admin dashboard (`/{conf}/admin/studio`). Choose
Banner, Sponsor overlay, or Sponsor reel, then review the setup preview before
applying it. Sponsors come from event data; empty tiers are skipped and levels
below Silver share the Regular group.

## Editing and saving

Click to select, Shift-click to select several objects, drag to move, and drag a
corner to resize proportionally. The inspector edits text, fonts, artwork, and
appearance. With nothing selected, it shows document and background controls.
Background dragging and zoom always keep the image covering the canvas.

Edit and Insert contain object commands; View opens Layers and the video timeline.
Hold Space to pan; use Fit and zoom to navigate. Reels support Play, scrubbing,
and dragging timeline bars or their endpoints. Undo/Redo includes complete gestures.

Save is explicit, and leaving with unsaved changes prompts to save or discard.
Concurrent saves report a conflict. File provides document setup, duplication,
recoverable deletion, and regeneration. Regenerating replaces the entire design,
including manual edits and replacement artwork; Undo restores it. Saved designs
are snapshots and do not automatically change with event data.

## Templates and export

- Banner: 850 × 2030 mm, no sponsor headings, with six inches (152.4 mm) reserved
  at the bottom for the roll-up base. Background extends into that area.
- Overlay: transparent 1920 × 1080, with Headline/Diamond sponsors and the bitcoin++
  logo; powered-by branding appears only when a Title sponsor is included.
- Reel: 1920 × 1080, one screen, with one-second beginning/end defaults. Uses
  Headline/Diamond, Title, Workshop/Hackathon, Silver, and Regular tiers.

Banner and reel backgrounds default to 50% darkness. File → Document setup changes
canvas size and Graphic/Video type. File → Export as saves first and exports that
exact revision: graphics offer PDF/PNG; video offers MP4. PDF retains physical
size and vector artwork; PNG uses 96 px/inch. Video uses 30 fps H.264/yuv420p with
silent stereo AAC at 48 kHz, matching conf-render. Overlay sample backgrounds
are preview-only.

Exports require Chrome, FFmpeg, and ffprobe (included in Docker); set `CHROME_PATH`
if needed. Allow six minutes at the proxy for the five-minute render timeout.
Artwork uploads are limited to 10 MB and documents to 32 MB. Fonts are bundled;
font uploads are not supported.

## Checks

```sh
node --test internal/studio/scene.test.cjs
CGO_ENABLED=0 go test ./internal/studio ./internal/handlers -run 'TestStudio|TestDocument|TestArtwork|TestFreeze'
STUDIO_RENDER_TEST=1 CGO_ENABLED=0 go test ./internal/studio -v
# Local development database only; the test removes its own fixture:
STUDIO_DB_TEST=1 CGO_ENABLED=0 go test ./internal/handlers -run TestStudioRevisionAndScope -v
```

On macOS, use `TMPDIR=/tmp` for the full Go suite if GPG cannot create its agent
socket under the default temporary path.
