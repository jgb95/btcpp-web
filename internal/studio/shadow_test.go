package studio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	imagecolor "image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chromedp/chromedp"
)

func shadowFixture(raster bool) Document {
	d := New("overlay")
	d.Kind = "graphic"
	d.Page = Page{Width: 600, Height: 240, Unit: "px"}
	d.Background.Color = "transparent"
	source := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="210" height="150"><path fill="red" fill-rule="evenodd" d="M50 50h80v80H50z M70 70v40h40V70z"/></svg>`))
	if raster {
		im := image.NewNRGBA(image.Rect(0, 0, 210, 150))
		draw.Draw(im, image.Rect(50, 50, 130, 130), &image.Uniform{imagecolor.RGBA{255, 0, 0, 255}}, image.Point{}, draw.Src)
		draw.Draw(im, image.Rect(70, 70, 110, 110), image.Transparent, image.Point{}, draw.Src)
		var b bytes.Buffer
		png.Encode(&b, im)
		source = "data:image/png;base64," + base64.StdEncoding.EncodeToString(b.Bytes())
	}
	n := Item("logo", "image", "Transparent logo")
	n.X = 20
	n.Y = 20
	n.Width = 210
	n.Height = 150
	n.Asset = d.Asset(source)
	n.Shadow = &Shadow{X: 8, Y: 8, Blur: 3, Color: "#000000", Opacity: .6}
	text := Item("title", "text", "Title")
	text.X = 230
	text.Y = 110
	text.Text = "Vector shadow"
	text.Color = "#222222"
	text.FontSize = 30
	text.Shadow = &Shadow{X: 2, Y: 3, Blur: 2, Color: "#000000", Opacity: .4}
	d.Nodes = []*Node{n, text}
	return d
}
func TestShadowValidation(t *testing.T) {
	d := shadowFixture(false)
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, s := range []*Shadow{{Blur: -1, Color: "#000000"}, {Blur: 51, Color: "#000000"}, {X: 201, Color: "#000000"}, {Color: "bad"}, {Color: "#000000", Opacity: 2}, {Color: "#000000", Blur: math.NaN()}} {
		d.Nodes[0].Shadow = s
		if d.Validate() == nil {
			t.Fatal("invalid shadow accepted", s)
		}
	}
}
func TestShadowRealExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir("internal/studio")
	for _, raster := range []bool{false, true} {
		d := shadowFixture(raster)
		path, _, _, err := RenderWithOptions(context.Background(), d, ExportOptions{Format: "png"})
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(path)
		raw, _ := os.ReadFile(path)
		im, e := png.Decode(bytes.NewReader(raw))
		if e != nil {
			t.Fatal(e)
		}
		for _, p := range []image.Point{{30, 30}, {110, 110}} {
			_, _, _, a := im.At(p.X, p.Y).RGBA()
			if a > 256 {
				t.Fatal("shadow filled transparent padding/hole", raster, p, a)
			}
		}
		_, _, _, a := im.At(155, 145).RGBA()
		if a == 0 {
			t.Fatal("shadow missing outside the artwork", raster)
		}
		if raster {
			continue
		}
		pdf, _, _, err := RenderWithOptions(context.Background(), d, ExportOptions{Format: "pdf"})
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(pdf)
		text, err := exec.Command("pdftotext", pdf, "-").Output()
		if err != nil || !strings.Contains(string(text), "Vector shadow") {
			t.Fatal("original text was rasterized", string(text), err)
		}
		svg := filepath.Join(t.TempDir(), "page.svg")
		output, err := exec.Command("pdftocairo", "-svg", pdf, svg).CombinedOutput()
		if err != nil {
			t.Fatal(string(output), err)
		}
		vector, _ := os.ReadFile(svg)
		normalized := strings.ReplaceAll(string(vector), " ", "")
		if !strings.Contains(normalized, `fill="rgb(100%,0%,0%)"`) && !strings.Contains(normalized, "fill:rgb(100%,0%,0%)") {
			t.Fatal("original SVG artwork lost its red vector path")
		}
		r := newRenderer(context.Background())
		var boxes [2]map[string]float64
		for i := range boxes {
			if i == 1 {
				d.Nodes[1].Shadow = nil
			}
			if err = r.load(d); err != nil {
				r.Close()
				t.Fatal(err)
			}
			raw, err := chromedp.Run(r.browser, chromedp.Evaluate[json.RawMessage](`window.scene.box('title')`))
			if err != nil {
				r.Close()
				t.Fatal(err)
			}
			if err = json.Unmarshal(raw, &boxes[i]); err != nil || boxes[i]["width"] <= 0 {
				r.Close()
				t.Fatal("invalid selection bounds", string(raw), err)
			}
		}
		r.Close()
		for _, key := range []string{"x", "y", "width", "height"} {
			if math.Abs(boxes[0][key]-boxes[1][key]) > .001 {
				t.Fatal("shadow expanded text selection bounds", boxes)
			}
		}
	}
}
