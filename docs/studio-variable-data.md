# Variable data in Studio

Choose **Canvas gifts** from an event's Studio. It uses the normal editor with a
Variable data sidebar: one shared layout, with artwork and number supplied by the
selected person. Names appear in filenames and the reference sheet, not on the
canvas. The old gifts page and CSV/artwork exports remain available.

## Graphic document setup

Open **File → Document setup → Variable data** on any Graphic document:

- **Off** keeps the current preview as ordinary shared content.
- **Event gift recipients** supplies the existing gift selection with event
  fields. Canvas gifts uses this same setup by default.
- **CSV file** imports UTF-8 CSV (including quoted commas/newlines), up to 1 MB,
  200 rows and 40 columns. Choose a display-name column and optionally one artwork
  column; all other columns are available to text objects. CSV row order is kept.
  An optional unique `ID` column preserves exclusions and overrides across edits;
  otherwise IDs follow row content. Exact duplicate rows stay separate.

Select text or an image, then choose **Variable field** in Properties. Text can
use a CSV/event field or the automatic batch number; image objects use the
selected artwork column. Multiple objects may use the same field. Font, color,
position, alignment and size remain normal shared edits. Choose **None (shared
content)** to detach a binding while keeping the selected row’s appearance.

CSV artwork uses Studio’s existing allowed HTTPS hosts or static assets, not
local filesystem paths. Missing/unavailable artwork can be replaced per row.
Use **Refresh data** to reimport a CSV or review event changes. Source changes,
row inclusion and binding edits are undoable. Turning variable data off leaves
an ordinary Graphic document; videos do not support variable data yet.

## Canvas gift recipients and editing

Recipients come from eligible event talks and explicitly tagged event staff.
Available artwork is preferred, then the smallest-panel talk; equal choices use
the talk ID for deterministic results. Stable person IDs deduplicate repeated
speakers. Duplicate names are warnings, not export blockers: deselect a repeated
person manually. Different people with the same name may remain included.
Missing artwork must be replaced or its row excluded.

On opening, Studio compares current event data and artwork hashes with the saved
snapshot. **Refresh data** shows additions, removals and changes before
applying them. Matching exclusions and per-person artwork overrides are retained.
An update is one undo step; it never silently changes a saved composition.

Toggle the sidebar with **Variable data** beside the row selector or **View → Variable data**.
Select a row or use previous/next to preview it. Layout, font, color and branding
edits apply to every recipient. Replacing the bound image changes only that
person's artwork; **Reset artwork to event source** removes the override. The
number's content is automatic, but its appearance and position remain editable.
Preview selection is not saved into the layout or counted as an edit.

The canvas preset uses 13 × 11.5 inches, a 10.75-inch-square image
starting 0.75 inch below the top, a locked dashed guide, and a right-aligned
six-point number in the upper margin. Events start with their normal logo.
Branding can be replaced using the ordinary inspector. Low effective print resolution produces a warning;
images are not silently upscaled. Output is RGB PDF, not PDF/X or CMYK.

## Numbering and downloads

Numbers are sequential within each reviewed batch. Speakers are alphabetical by
display name; only recipients using the event's leading artwork are grouped last,
also alphabetically. Stable IDs break name ties. Different people sharing an
image receive separate PDFs. Padding starts at two digits and grows at 100.
Changing inclusion or refreshing recipients recalculates the complete batch.
Very long names are shortened in filenames to fit the reference sheet; the full
name remains in the manifest.

**File → Export as** offers the selected row’s PDF or PNG, or a ZIP of all included PDFs.
**Artwork manifest PDF** exports the same printable reference sheet, using
previews of the final documents including branding, numbering, background, and
manual layout edits, without generating all the individual PDF files. Exports save first and check the reviewed source fingerprint. A source change
requires another review. ZIP export freezes the revision, order and original
artwork bytes, reuses one Chrome session, and only downloads a complete package:

- `pdf/01 - Recipient name.pdf`, with the matching number printed on the canvas;
- `artwork-reference.pdf`, an A4 four-column grid of finished-document previews with exact filenames;
- `manifest.json`, with event/design revision, source fingerprint, recipient IDs,
  exclusions, numbering, original pixel sizes, effective resolution and SHA-256
  hashes for artwork, PDFs and the reference sheet.

Batch export uses Studio's existing concurrency limit and five-minute timeout.
Limits are 200 recipients, 10 MB per artwork, 256 MB frozen artwork and 512 MB
uncompressed output. Variable originals are resolved outside the document asset
collection; manually uploaded overrides still count toward the 32 MB saved
document limit. Temporary files are removed after completion or failure. Failed
exports can be retried; there are no durable jobs, permanent numbers or export
history in this version.

## Verification

Standard Studio checks include canvas data, binding, identity and geometry tests.
`STUDIO_RENDER_TEST=1` also verifies real PDF/ZIP exports with synthetic artwork.

Set `CHROME_PATH` when needed; on macOS, use `TMPDIR=/tmp` for Go test execution.
