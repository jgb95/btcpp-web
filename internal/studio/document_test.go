package studio

import (
	"bytes"
	"context"
	"encoding/base64"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func testDocument(kind string) Document {
	d := New(kind)
	n := Item("logo", "image", "Vector logo")
	n.Width = 300
	n.Height = 100
	n.X = 100
	n.Y = 200
	n.Asset = d.Asset("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><path fill="red" d="M0 0h300v100H0z"/></svg>`)))
	d.Nodes = append(d.Nodes, n)
	return d
}
func TestDocumentValidation(t *testing.T) {
	for _, kind := range []string{"banner", "overlay", "reel"} {
		d := testDocument(kind)
		if e := d.Validate(); e != nil {
			t.Fatal(e)
		}
	}
	for _, change := range []func(*Document){func(d *Document) { d.Nodes = append(d.Nodes, d.Nodes[0]) }, func(d *Document) { d.Nodes[0].Scale = 0 }, func(d *Document) { d.Nodes[0].Asset = "missing" }, func(d *Document) { d.Nodes[0].Kind = "text"; d.Nodes[0].Font = "MissingFont" }, func(d *Document) { d.Assets[d.Nodes[0].Asset] = "https://localhost/secret" }, func(d *Document) { d.Page.Width = 4 }, func(d *Document) { d.Nodes[0].Animation = &Timing{Start: 3, End: 2} }, func(d *Document) { d.Nodes[0].Children = []*Node{Item("child", "group", "child")} }} {
		d := testDocument("reel")
		change(&d)
		if d.Validate() == nil {
			t.Fatal("accepted invalid document")
		}
	}
}
func TestStudioRealExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1 for real Chrome/FFmpeg exports")
	}
	if e := os.Chdir("../.."); e != nil {
		t.Fatal(e)
	}
	defer os.Chdir("internal/studio")
	for _, kind := range []string{"overlay", "banner", "reel"} {
		t.Run(kind, func(t *testing.T) {
			d := testDocument(kind)
			if kind == "reel" {
				d.Duration = 2
				d.Nodes[0].Animation = &Timing{Start: .2, End: 1.8, Fade: .2, Rise: 40}
			}
			if kind == "banner" {
				n := Item("text", "text", "Text")
				n.Text = "Studio vector text"
				n.X = 100
				n.Y = 400
				d.Nodes = append(d.Nodes, n)
			}
			options := ExportOptions{}
			if kind == "banner" {
				options.Format = "pdf"
			}
			path, _, ext, e := RenderWithOptions(context.Background(), d, options)
			if e != nil {
				t.Fatal(e)
			}
			defer os.Remove(path)
			data, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			if kind == "overlay" {
				img, e := png.Decode(bytes.NewReader(data))
				if e != nil {
					t.Fatal(e)
				}
				if img.Bounds().Dx() != 1920 || img.Bounds().Dy() != 1080 {
					t.Fatal(img.Bounds())
				}
				_, _, _, a := img.At(960, 540).RGBA()
				if a != 0 {
					t.Fatal("background not transparent")
				}
				r, _, _, a := img.At(150, 250).RGBA()
				if r == 0 || a == 0 {
					t.Fatal("vector artwork missing")
				}
			}
			if kind == "banner" && !strings.HasPrefix(string(data), "%PDF") {
				t.Fatal("not a PDF")
			}
			if output := os.Getenv("STUDIO_TEST_OUTPUT_DIR"); output != "" {
				if e = os.MkdirAll(output, 0700); e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(filepath.Join(output, "new-"+kind+ext), data, 0600); e != nil {
					t.Fatal(e)
				}
			}
		})
	}
}

func TestStudioMissingArtwork(t *testing.T) {
	d := testDocument("overlay")
	d.Assets[d.Nodes[0].Asset] = "/static/img/studio-missing-original.svg"
	if err := Freeze(context.Background(), &d); err == nil || !strings.Contains(err.Error(), "Vector logo") {
		t.Fatalf("expected named artwork error, got %v", err)
	}
	d.Background.Color = "#ffffff"
	if d.Validate() == nil {
		t.Fatal("overlay accepted an export background")
	}
}

func TestStudioExportOptions(t *testing.T) {
	for _, kind := range []string{"banner", "overlay", "reel"} {
		for _, format := range []string{"", "png", "pdf", "mp4", "exe"} {
			o := ExportOptions{Format: format}
			wantError := format == "exe" || (format == "mp4" && kind != "reel") || (kind == "reel" && (format == "png" || format == "pdf"))
			if (o.Validate(New(kind)) != nil) != wantError {
				t.Fatalf("%s/%s validation", kind, format)
			}
		}
	}
}

func TestStudioAlternateExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if e := os.Chdir("../.."); e != nil {
		t.Fatal(e)
	}
	defer os.Chdir("internal/studio")
	for _, kind := range []string{"banner", "overlay"} {
		for _, format := range []string{"png", "pdf"} {
			t.Run(kind+"-"+format, func(t *testing.T) {
				d := testDocument(kind)
				n := Item("text", "text", "Wordmark")
				n.Text = "bitcoin++"
				n.Font = "BannerBrand"
				n.X = 100
				n.Y = 400
				d.Nodes = append(d.Nodes, n)
				options := ExportOptions{Format: format}
				path, _, ext, err := RenderWithOptions(context.Background(), d, options)
				if err != nil {
					t.Fatal(err)
				}
				defer os.Remove(path)
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if ext != "."+format {
					t.Fatal(ext)
				}
				if format == "pdf" && !bytes.HasPrefix(data, []byte("%PDF")) {
					t.Fatal("missing PDF")
				}
				if format == "png" {
					img, err := png.Decode(bytes.NewReader(data))
					if err != nil {
						t.Fatal(err)
					}
					w, h := d.PixelSize()
					if img.Bounds().Dx() != int(math.Ceil(w)) || img.Bounds().Dy() != int(math.Ceil(h)) {
						t.Fatal(img.Bounds())
					}
				}
			})
		}
	}
}

func TestStudioGenerationMetadata(t *testing.T) {
	d := testDocument("banner")
	d.Generation = &Generation{Size: 1, Spacing: 1}
	d.ArtworkBounds = map[string]ArtworkBounds{d.Nodes[0].Asset: {X: .1, Y: .2, Width: .8, Height: .6}}
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	d.Generation.Size = 2
	if d.Validate() == nil {
		t.Fatal("accepted invalid logo size")
	}
	d.Generation.Size = 1
	for _, b := range []ArtworkBounds{{Width: 0, Height: 1}, {X: .8, Width: .5, Height: 1}, {Y: -.1, Width: 1, Height: 1}} {
		d.ArtworkBounds[d.Nodes[0].Asset] = b
		if d.Validate() == nil {
			t.Fatal("accepted invalid bounds", b)
		}
	}
}

func TestStudioCroppedExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir("internal/studio")
	d := New("overlay")
	n := Item("padded", "image", "Padded vector")
	n.X = 100
	n.Y = 200
	n.Width = 400
	n.Height = 200
	n.Asset = d.Asset("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000"><path fill="red" d="M100 300h800v400H100z"/></svg>`)))
	d.Nodes = []*Node{n}
	d.ArtworkBounds = map[string]ArtworkBounds{n.Asset: {X: .1, Y: .3, Width: .8, Height: .4}}
	for _, format := range []string{"png", "pdf"} {
		path, _, _, err := RenderWithOptions(context.Background(), d, ExportOptions{Format: format})
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(path)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if format == "pdf" {
			if bytes.Contains(data, []byte("/Subtype /Image")) {
				t.Fatal("cropped vector was rasterized")
			}
			if _, err := exec.LookPath("pdftoppm"); err == nil {
				preview := path + "-preview"
				if output, err := exec.Command("pdftoppm", "-scale-to-x", "1920", "-scale-to-y", "1080", "-singlefile", "-png", path, preview).CombinedOutput(); err != nil {
					t.Fatalf("PDF preview: %v %s", err, output)
				}
				defer os.Remove(preview + ".png")
				pngData, err := os.ReadFile(preview + ".png")
				if err != nil {
					t.Fatal(err)
				}
				img, err := png.Decode(bytes.NewReader(pngData))
				if err != nil {
					t.Fatal(err)
				}
				r, g, b, _ := img.At(110, 210).RGBA()
				if r < 60000 || g > 1000 || b > 1000 {
					t.Fatal("PDF crop differs from PNG layout", r, g, b)
				}
				_, g, b, _ = img.At(510, 210).RGBA()
				if g < 60000 || b < 60000 {
					t.Fatal("PDF crop escaped its box")
				}
			}
		} else {
			img, err := png.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			r, g, b, a := img.At(110, 210).RGBA()
			if r < 60000 || g > 1000 || b > 1000 || a < 60000 {
				t.Fatal("visible crop did not fill its box", r, g, b, a)
			}
			_, _, _, a = img.At(90, 210).RGBA()
			if a != 0 {
				t.Fatal("artwork escaped crop")
			}
		}
	}
}

func TestDocumentSetupKindsAndUnits(t *testing.T) {
	d := testDocument("reel")
	d.Kind = "print"
	d.Page = Page{4, 6, "in", .125}
	if e := d.Validate(); e != nil {
		t.Fatal(e)
	}
	w, h := d.PixelSize()
	if w != 408 || h != 600 {
		t.Fatal(w, h)
	}
	if (ExportOptions{Format: "mp4"}).Validate(d) == nil {
		t.Fatal("static document accepted MP4")
	}
	d.Kind = "video"
	d.Page = Page{320, 180, "px", 0}
	if e := d.Validate(); e != nil {
		t.Fatal(e)
	}
	d.Page.Width = 321
	if d.Validate() == nil {
		t.Fatal("odd video width accepted")
	}
	d.Page = Page{10000, 10000, "px", 0}
	if d.Validate() == nil {
		t.Fatal("unbounded canvas accepted")
	}
	d = testDocument("overlay")
	d.Kind = "graphic"
	d.Background.Color = "#ffffff"
	d.Background.Zoom = 2
	if e := d.Validate(); e != nil {
		t.Fatal(e)
	}
	n := Item("small-text", "text", "Small type")
	n.Text = "Small type"
	n.FontSize = 1.0 / 12
	d.Nodes = append(d.Nodes, n)
	d.Kind = "print"
	d.Page = Page{4, 6, "in", 0}
	if e := d.Validate(); e != nil {
		t.Fatal("unit-converted font rejected", e)
	}
	d.Background.Zoom = 9
	if d.Validate() == nil {
		t.Fatal("invalid background zoom accepted")
	}
}
func TestStudioCustomCanvasExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if e := os.Chdir("../.."); e != nil {
		t.Fatal(e)
	}
	defer os.Chdir("internal/studio")
	d := testDocument("overlay")
	d.Kind = "graphic"
	d.Page = Page{360, 640, "px", 0}
	path, _, _, e := Render(context.Background(), d)
	if e != nil {
		t.Fatal(e)
	}
	defer os.Remove(path)
	raw, _ := os.ReadFile(path)
	img, e := png.Decode(bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	if img.Bounds().Dx() != 360 || img.Bounds().Dy() != 640 {
		t.Fatal(img.Bounds())
	}
	_, _, _, alpha := img.At(0, 0).RGBA()
	if alpha != 0 {
		t.Fatal("PNG lost transparency")
	}
	d.Kind = "print"
	d.Page = Page{4, 6, "in", .125}
	d.Nodes[0].X = .25
	d.Nodes[0].Y = .5
	d.Nodes[0].Width = 3
	d.Nodes[0].Height = 1
	path, _, _, e = RenderWithOptions(context.Background(), d, ExportOptions{Format: "pdf"})
	if e != nil {
		t.Fatal(e)
	}
	defer os.Remove(path)
	raw, _ = os.ReadFile(path)
	if bytes.Contains(raw, []byte("/Subtype /Image")) {
		t.Fatal("PDF vector art rasterized")
	}
	if _, e := exec.LookPath("pdfinfo"); e == nil {
		info, e := exec.Command("pdfinfo", path).CombinedOutput()
		if e != nil || !bytes.Contains(info, []byte("306 x 450 pts")) {
			t.Fatalf("PDF dimensions: %s %v", info, e)
		}
	}
	d.Kind = "video"
	d.Duration = 2
	d.Page = Page{320, 180, "px", 0}
	d.Nodes[0].Y = 20
	d.Nodes[0].X = 10
	path, _, _, e = Render(context.Background(), d)
	if e != nil {
		t.Fatal(e)
	}
	defer os.Remove(path)
	if e := VerifyVideo(context.Background(), path, 2, 320, 180); e != nil {
		t.Fatal(e)
	}
}

func TestStudioBackgroundFramingExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if e := os.Chdir("../.."); e != nil {
		t.Fatal(e)
	}
	defer os.Chdir("internal/studio")
	d := New("overlay")
	d.Kind = "graphic"
	d.Page = Page{200, 100, "px", 0}
	d.Background = Background{Color: "transparent", Zoom: 2, X: 300}
	d.Background.Asset = d.Asset("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><path fill="red" d="M0 0h200v100H0z"/><path fill="blue" d="M200 0h200v100H200z"/></svg>`)))
	for _, format := range []string{"png", "pdf"} {
		path, _, _, e := RenderWithOptions(context.Background(), d, ExportOptions{Format: format})
		if e != nil {
			t.Fatal(e)
		}
		defer os.Remove(path)
		if format == "pdf" {
			if _, e := exec.LookPath("pdftoppm"); e != nil {
				continue
			}
			preview := path + "-preview"
			if out, e := exec.Command("pdftoppm", "-scale-to-x", "200", "-scale-to-y", "100", "-singlefile", "-png", path, preview).CombinedOutput(); e != nil {
				t.Fatalf("%s %v", out, e)
			}
			path = preview + ".png"
			defer os.Remove(path)
		}
		raw, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		img, e := png.Decode(bytes.NewReader(raw))
		if e != nil {
			t.Fatal(e)
		}
		for _, x := range []int{10, 190} {
			r, g, b, a := img.At(x, 50).RGBA()
			if r < 60000 || g > 1000 || b > 1000 || a < 60000 {
				t.Fatalf("%s background framing differs: %d %d %d", format, r, g, b)
			}
		}
	}
}

func TestDocumentGraphicCompatibility(t *testing.T) {
	d := testDocument("banner")
	for _, kind := range []string{"", "print", "graphic"} {
		d.Kind = kind
		if d.Type() != "graphic" {
			t.Fatal("legacy banner is not a graphic")
		}
		if err := d.Validate(); err != nil {
			t.Fatal(err)
		}
		for _, format := range []string{"png", "pdf"} {
			if err := (ExportOptions{Format: format}).Validate(d); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestStudioBackgroundCoverageExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir("internal/studio")
	d := New("overlay")
	d.Kind = "graphic"
	d.Page = Page{200, 100, "px", 0}
	d.Background = Background{Color: "#00ff00", X: 10000, Y: -10000}
	d.Background.Asset = d.Asset("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><path fill="red" d="M0 0h200v100H0z"/><path fill="blue" d="M200 0h200v100H200z"/></svg>`)))
	for _, format := range []string{"png", "pdf"} {
		path, _, _, err := RenderWithOptions(context.Background(), d, ExportOptions{Format: format})
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(path)
		if format == "pdf" {
			if _, err := exec.LookPath("pdftoppm"); err != nil {
				continue
			}
			preview := path + "-preview"
			if out, err := exec.Command("pdftoppm", "-scale-to-x", "200", "-scale-to-y", "100", "-singlefile", "-png", path, preview).CombinedOutput(); err != nil {
				t.Fatalf("%s %v", out, err)
			}
			path = preview + ".png"
			defer os.Remove(path)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		for _, sample := range []struct{ x, y, channel int }{{10, 10, 0}, {10, 50, 0}, {190, 50, 0}, {190, 90, 0}} {
			r, g, b, a := img.At(sample.x, sample.y).RGBA()
			channels := []uint32{r, g, b}
			if channels[sample.channel] < 60000 || channels[(sample.channel+1)%3] > 1000 || channels[(sample.channel+2)%3] > 1000 || a < 60000 {
				t.Fatalf("%s background coverage differs at %d,%d: %d %d %d %d", format, sample.x, sample.y, r, g, b, a)
			}
		}
	}
}
