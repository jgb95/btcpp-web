package studio

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

const MaxBatchBytes = 256 << 20

type Artwork struct {
	Source        string
	Hash          string
	Width, Height int
}

func InspectArtwork(ctx context.Context, source string) (Artwork, error) {
	original, err := LoadArtwork(ctx, source)
	if err != nil {
		return Artwork{}, err
	}
	_, encoded, _ := strings.Cut(original, ",")
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return Artwork{}, err
	}
	a := Artwork{Source: original, Hash: fmt.Sprintf("%x", sha256.Sum256(data))}
	cfg, _, e := image.DecodeConfig(bytes.NewReader(data))
	if e == nil {
		a.Width, a.Height = cfg.Width, cfg.Height
	}
	return a, nil
}

// MeasureRows records source hashes without embedding variable artwork in the document.
func MeasureRows(ctx context.Context, rows []Recipient, requireArtwork bool) (map[string]Artwork, error) {
	cache := map[string]Artwork{}
	failures := map[string]string{}
	total := 0
	for i := range rows {
		r := &rows[i]
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if r.Source == "" {
			if requireArtwork && !strings.HasPrefix(r.Issue, "Artwork:") {
				r.Issue = "Artwork: missing artwork"
			}
			continue
		}
		a, ok := cache[r.Source]
		if !ok && failures[r.Source] == "" {
			var err error
			a, err = InspectArtwork(ctx, r.Source)
			if err != nil {
				failures[r.Source] = "Artwork: " + err.Error()
			} else {
				total += len(a.Source)
				if total > MaxBatchBytes {
					return nil, fmt.Errorf("batch artwork exceeds 256 MB")
				}
				cache[r.Source] = a
			}
		}
		if e := failures[r.Source]; e != "" {
			r.Issue = e
			continue
		}
		r.Hash, r.Width, r.Height = a.Hash, a.Width, a.Height
	}
	return cache, nil
}

// ArtworkPPI follows proportional group scaling and the image's contain fit.
func ArtworkPPI(d Document, a Artwork) float64 {
	if a.Width <= 0 || a.Height <= 0 {
		return 0
	}
	factor := 1. / 96
	if d.Page.Unit == "mm" {
		factor = 1 / 25.4
	} else if d.Page.Unit == "in" {
		factor = 1
	}
	result := 0.
	var visit func([]*Node, float64)
	visit = func(nodes []*Node, parentScale float64) {
		for _, n := range nodes {
			scale := parentScale * n.Scale
			if n.Binding != nil && n.Binding.Row == "artwork" && n.Width > 0 && n.Height > 0 {
				ppi := max(float64(a.Width)/(n.Width*scale*factor), float64(a.Height)/(n.Height*scale*factor))
				if result == 0 || ppi < result {
					result = ppi
				}
			}
			visit(n.Children, scale)
		}
	}
	visit(d.Nodes, 1)
	return result
}
