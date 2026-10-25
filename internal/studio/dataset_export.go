package studio

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"os"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
)

type DatasetManifestEntry struct {
	ID          string  `json:"recipientId"`
	Name        string  `json:"name"`
	TalkID      string  `json:"talkId,omitempty"`
	Number      string  `json:"number"`
	Filename    string  `json:"filename"`
	Source      string  `json:"source"`
	ArtworkHash string  `json:"artworkSha256"`
	PDFHash     string  `json:"pdfSha256"`
	Width       int     `json:"pixelWidth,omitempty"`
	Height      int     `json:"pixelHeight,omitempty"`
	PPI         float64 `json:"effectivePpi,omitempty"`
	Override    bool    `json:"override,omitempty"`
	Warning     string  `json:"warning,omitempty"`
}
type DatasetManifest struct {
	Version       int                    `json:"version"`
	Renderer      string                 `json:"renderer"`
	Event         string                 `json:"event"`
	Design        string                 `json:"designId"`
	Revision      int                    `json:"revision"`
	Created       time.Time              `json:"createdAt"`
	DocumentHash  string                 `json:"documentSha256"`
	Fingerprint   string                 `json:"sourceFingerprint"`
	Page          Page                   `json:"page"`
	Fonts         map[string]string      `json:"fonts"`
	Recipients    []DatasetManifestEntry `json:"recipients"`
	Excluded      []string               `json:"excludedRecipientIds,omitempty"`
	ReferenceHash string                 `json:"referenceSha256"`
}

func digest(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }

// RenderDataset freezes a reviewed batch and only publishes complete output.
func RenderDataset(parent context.Context, d Document, assets map[string]Artwork, event, design string, revision int, selected, format string) (path string, err error) {
	if format != "pdf" && format != "png" && format != "zip" && format != "reference" {
		return "", fmt.Errorf("choose PDF, PNG, or ZIP")
	}
	zipOutput := format == "zip"
	batch := zipOutput || format == "reference"
	if err = d.Validate(); err != nil {
		return "", err
	}
	if d.Type() != "graphic" || d.Dataset == nil {
		return "", fmt.Errorf("canvas recipient data is missing")
	}
	check := *d.Dataset
	if !batch {
		check.Excluded = append([]string{}, d.Dataset.Excluded...)
		for _, row := range d.Dataset.Rows {
			if row.ID != selected {
				check.Excluded = append(check.Excluded, row.ID)
			}
		}
	}
	if err = check.Check(d.UsesVariableArtwork()); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()
	if err = Freeze(ctx, &d); err != nil {
		return "", err
	}
	rows := d.Dataset.Included()
	frozen := map[string]Artwork{}
	total := 0
	for _, row := range rows {
		if !batch && row.ID != selected {
			continue
		}
		source := d.Dataset.Artwork(row)
		if !d.UsesVariableArtwork() {
			continue
		}
		if _, ok := frozen[source]; ok {
			continue
		}
		a, ok := assets[source]
		if !ok {
			a, err = InspectArtwork(ctx, source)
			if err != nil {
				return "", fmt.Errorf("%s: %w", row.Name, err)
			}
		}
		total += len(a.Source)
		if total > MaxBatchBytes {
			return "", fmt.Errorf("batch artwork exceeds 256 MB")
		}
		frozen[source] = a
	}
	ext := "." + format
	if format == "reference" {
		ext = ".pdf"
	}
	if zipOutput {
		ext = ".zip"
	}
	f, err := os.CreateTemp("", "studio-canvas-*"+ext)
	if err != nil {
		return "", err
	}
	path = f.Name()
	defer func() {
		f.Close()
		if err != nil {
			os.Remove(path)
		}
	}()
	r := newRenderer(ctx)
	defer r.Close()
	raw, _ := json.Marshal(d)
	manifest := DatasetManifest{Version: 1, Renderer: "studio-canvas-1", Event: event, Design: design, Revision: revision, Created: time.Now().UTC(), DocumentHash: digest(raw), Fingerprint: d.Dataset.Fingerprint, Page: d.Page, Fonts: Fonts, Recipients: []DatasetManifestEntry{}, Excluded: d.Dataset.Excluded}
	var zw *zip.Writer
	if zipOutput {
		zw = zip.NewWriter(f)
	}
	written := 0
	write := func(name string, b []byte) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		written += len(b)
		if written > 512<<20 {
			return fmt.Errorf("canvas package exceeds 512 MB")
		}
		entry, e := zw.Create(name)
		if e != nil {
			return e
		}
		_, e = entry.Write(b)
		return e
	}
	previews := map[string]string{}
	previewBytes := 0
	for i, row := range rows {
		if !batch && row.ID != selected {
			continue
		}
		a := frozen[d.Dataset.Artwork(row)]
		number := RecipientNumber(i, len(rows))
		filename := RecipientFilename(number, row.Name)
		doc := BindRow(d, a.Source, number, RowValues(row))
		if err = r.load(doc); err != nil {
			return path, fmt.Errorf("%s: %w", row.Name, err)
		}
		var pdf []byte
		if format != "reference" {
			if format == "png" {
				pdf, err = chromedp.Run(r.browser, chromedp.CaptureScreenshot())
			} else {
				pdf, err = r.pdf()
			}
			if err != nil {
				return path, err
			}
			if !batch {
				_, err = f.Write(pdf)
				return path, err
			}
			if err = write("pdf/"+filename, pdf); err != nil {
				return path, err
			}
		}

		preview, e := r.thumbnail(doc)
		if e != nil {
			return path, fmt.Errorf("%s preview: %w", row.Name, e)
		}
		previewBytes += len(preview)
		if previewBytes > MaxBatchBytes {
			return path, fmt.Errorf("document previews exceed 256 MB")
		}
		previews[row.ID] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(preview)
		entry := DatasetManifestEntry{ID: row.ID, Name: row.Name, TalkID: row.TalkID, Number: number, Filename: filename, Source: row.Source, ArtworkHash: a.Hash, PDFHash: digest(pdf), Width: a.Width, Height: a.Height, Override: d.Dataset.Overrides[row.ID] != ""}
		if entry.Override {
			entry.Source = "uploaded:" + a.Hash
		}
		entry.PPI = ArtworkPPI(doc, a)
		if entry.PPI > 0 && entry.PPI < 150 {
			entry.Warning = "Original artwork is below 150 ppi at the placed size"
		}

		manifest.Recipients = append(manifest.Recipients, entry)
	}
	if !batch {
		return path, fmt.Errorf("select an included recipient")
	}
	if err = r.loadHTML(datasetReference(manifest.Recipients, previews), 794, 1123); err != nil {
		return path, err
	}
	// Keep exact filenames, shrinking long labels to two lines instead of clipping them.
	_, err = chromedp.Run(r.browser, chromedp.Evaluate[bool](`(async()=>{await Promise.all(Array.from(document.images,i=>i.decode()));for(const e of document.querySelectorAll('p')){let size=8.5;while(e.scrollHeight>e.clientHeight+1&&size>6){size-=.25;e.style.fontSize=size+'pt'}if(e.scrollHeight>e.clientHeight+1)throw Error('Filename too long for reference: '+e.textContent)}return true})()`, chromedp.EvalAwaitPromise))
	if err != nil {
		return path, err
	}
	var reference []byte
	reference, err = r.pdf()
	if err != nil {
		return path, err
	}
	if format == "reference" {
		if len(reference) > 512<<20 {
			return path, fmt.Errorf("manifest exceeds 512 MB")
		}
		_, err = f.Write(reference)
		return path, err
	}
	manifest.ReferenceHash = digest(reference)
	if err = write("artwork-reference.pdf", reference); err != nil {
		return path, err
	}
	raw, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return path, err
	}
	if err = write("manifest.json", raw); err != nil {
		return path, err
	}
	err = zw.Close()
	return path, err
}
func datasetReference(entries []DatasetManifestEntry, previews map[string]string) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:24pt}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}.page{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,187pt);gap:12pt;break-after:page}.page:last-child{break-after:auto}.cell{min-width:0;text-align:center}.preview{height:128pt;display:flex;align-items:center;justify-content:center}.preview img{max-width:100%;max-height:100%;width:auto;height:auto;box-shadow:0 0 0 .5pt #ccc}p{font-size:8.5pt;line-height:10.5pt;height:22pt;margin:5pt 0;overflow:hidden;overflow-wrap:anywhere}</style>`)
	for i, e := range entries {
		if i%16 == 0 {
			b.WriteString(`<div class="page">`)
		}
		fmt.Fprintf(&b, `<div class="cell"><div class="preview"><img src="%s"></div>`, html.EscapeString(previews[e.ID]))
		fmt.Fprintf(&b, `<p>%s</p></div>`, html.EscapeString(e.Filename))
		if i%16 == 15 || i == len(entries)-1 {
			b.WriteString(`</div>`)
		}
	}
	return b.String()
}
