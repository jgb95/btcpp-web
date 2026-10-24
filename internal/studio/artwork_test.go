package studio

import (
	"context"
	"encoding/base64"
	"testing"
)

func TestArtworkSourceRestrictions(t *testing.T) {
	for _, source := range []string{"/static/../.env", "/static/%2e%2e/.env", "/static/a.svg?redirect=/admin", "https://localhost/logo.png", "https://btcpp.dev.evil.test/a.png", "https://user@btcpp.dev/a.png", "https://btcpp.dev:123/a.png", "data:text/html;base64,PHN2Zy8+", "data:image/svg+xml;base64,"} {
		if validSource(source) {
			t.Errorf("accepted %s", source)
		}
	}
	for _, source := range []string{"/static/img/logo.avif", "https://btcpp.dev/static/logo.svg", "https://btcpp.nyc3.digitaloceanspaces.com/sponsors/logo.svg", "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))} {
		if !validSource(source) {
			t.Errorf("rejected %s", source)
		}
	}
}
func TestFreezeKeepsOriginalsAndPrunesUnusedAssets(t *testing.T) {
	d := testDocument("overlay")
	source := d.Assets[d.Nodes[0].Asset]
	d.Assets["unused"] = "/static/missing-unused.svg"
	d.ArtworkBounds = map[string]ArtworkBounds{"unused": {Width: 1, Height: 1}, d.Nodes[0].Asset: {Width: 1, Height: 1}}
	if err := Freeze(context.Background(), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Assets) != 1 || d.Assets[d.Nodes[0].Asset] != source || len(d.ArtworkBounds) != 1 {
		t.Fatal("originals or measured bounds changed")
	}
}
