package studio

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCSVData(t *testing.T) {
	ctx := context.Background()
	raw := "\ufeffID,Name,Message\r\nb,Zoë,\"Hello, Seoul\"\r\na,李,\"two\nlines\"\r\n"
	ds, err := PrepareCSV(ctx, raw, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if ds.Included()[0].ID != "b" || ds.Rows[1].Values["Message"] != "two\nlines" {
		t.Fatal("CSV order or quoted fields changed")
	}
	if err = ds.Check(false); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"Name,Name\nA,B", "ID,Name\na,A\na,B", "Name\n", "Name,Value\nA", "Name\n\"unclosed", "Name\n" + strings.Repeat("x", 2001), strings.Repeat("x", 1<<20+1)} {
		if _, err := PrepareCSV(ctx, raw, "", ""); err == nil {
			t.Fatalf("invalid CSV accepted: %.40q", raw)
		}
	}
	a, _ := PrepareCSV(ctx, "Name\nA\nB", "", "")
	b, _ := PrepareCSV(ctx, "Name\nB\nA", "", "")
	if a.Rows[0].ID != b.Rows[1].ID {
		t.Fatal("row identity changed on reordering")
	}
	d := New("banner")
	d.Page = Page{Width: 600, Height: 400, Unit: "px"}
	d.Dataset = ds
	n := Item("greeting", "text", "Greeting")
	n.Text = "Shared"
	n.FontSize = 24
	n.Binding = &Binding{Row: "field", Column: "Message"}
	d.Nodes = []*Node{n}
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(d)
	bound := BindRow(d, "", "01", ds.Rows[0].Values)
	after, _ := json.Marshal(d)
	if string(before) != string(after) || bound.Nodes[0].Text != "Hello, Seoul" || bound.Dataset != nil {
		t.Fatal("binding mutated shared data")
	}
	d.Kind = "video"
	d.Duration = 5
	if d.Validate() == nil {
		t.Fatal("video accepted variable data")
	}
}
func TestCSVRealExports(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir("internal/studio")
	ds, err := PrepareCSV(context.Background(), "ID,Name,Message\nb,Zoë,Hello Seoul\na,Adam,Second row", "", "")
	if err != nil {
		t.Fatal(err)
	}
	d := New("banner")
	d.Page = Page{Width: 600, Height: 400, Unit: "px"}
	d.Background.Color = "transparent"
	d.Dataset = ds
	n := Item("message", "text", "Message")
	n.X = 20
	n.Y = 50
	n.FontSize = 24
	n.Text = "Shared"
	n.Binding = &Binding{Row: "field", Column: "Message"}
	d.Nodes = []*Node{n}
	for _, format := range []string{"pdf", "png", "zip", "reference"} {
		path, err := RenderDataset(context.Background(), d, nil, "test", "design", 1, "b", format)
		if err != nil {
			t.Fatal(format, err)
		}
		defer os.Remove(path)
		if format == "reference" {
			checkReferencePreviews(t, path, 2)
			text, e := exec.Command("pdftotext", path, "-").Output()
			if e != nil || !strings.Contains(string(text), "Adam.pdf") || !strings.Contains(string(text), "Zoë.pdf") {
				t.Fatal("manifest missing rows", string(text), e)
			}
		}
		if format == "pdf" {
			out, err := exec.Command("pdftotext", path, "-").Output()
			if err != nil || !strings.Contains(string(out), "Hello Seoul") || strings.Contains(string(out), "Second row") {
				t.Fatal(string(out), err)
			}
		}
		if format == "png" {
			raw, _ := os.ReadFile(path)
			im, e := png.Decode(bytes.NewReader(raw))
			if e != nil {
				t.Fatal(e)
			}
			_, _, _, alpha := im.At(0, 0).RGBA()
			if alpha != 0 || im.Bounds().Dx() != 600 || im.Bounds().Dy() != 400 {
				t.Fatal("PNG dimensions/transparency changed")
			}
		}
		if format == "zip" {
			z, e := zip.OpenReader(path)
			if e != nil {
				t.Fatal(e)
			}
			if len(z.File) != 4 {
				t.Fatal("wrong batch contents")
			}
			for _, f := range z.File {
				if strings.HasSuffix(f.Name, ".pdf") {
					target := filepath.Join(t.TempDir(), filepath.Base(f.Name))
					r, _ := f.Open()
					raw, readErr := io.ReadAll(r)
					if readErr != nil {
						t.Fatal(readErr)
					}
					r.Close()
					_ = os.WriteFile(target, raw, 0600)
					if f.Name == "artwork-reference.pdf" {
						checkReferencePreviews(t, target, 2)
					}
					if strings.HasPrefix(f.Name, "pdf/") {
						text, e := exec.Command("pdftotext", target, "-").Output()
						if e != nil {
							t.Fatal(e)
						}
						expected := "Hello Seoul"
						if strings.Contains(f.Name, "Adam") {
							expected = "Second row"
						}
						if !strings.Contains(string(text), expected) {
							t.Fatalf("wrong row PDF: %s: %s", f.Name, text)
						}
					}
				}
			}
			z.Close()
		}
	}
}

func TestCSVArtworkReview(t *testing.T) {
	source := canvasFixture().Dataset.Rows[0].Source
	ds, err := PrepareCSV(context.Background(), "Name,Artwork\nA,\""+source+"\"", "", "auto")
	if err != nil {
		t.Fatal(err)
	}
	if ds.ImageColumn != "Artwork" || ds.Rows[0].Hash == "" || ds.Check(true) != nil {
		t.Fatal("artwork not measured")
	}
	bad, err := PrepareCSV(context.Background(), "Name,Artwork\nA,http://127.0.0.1/private", "", "auto")
	if err != nil {
		t.Fatal(err)
	}
	if bad.Rows[0].Source != "" || bad.Check(true) == nil {
		t.Fatal("unsafe image source accepted")
	}
}

func TestSharedDatasetColumns(t *testing.T) {
	ds, err := PrepareCSV(context.Background(), "ID,Name,Message\na,Adam,Hello", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"csv", "event_gifts"} {
		ds.Source = source
		if err := ds.Validate(); err != nil {
			t.Fatal(source, err)
		}
		d := New("banner")
		d.Dataset = ds
		n := Item("message", "text", "Message")
		n.Binding = &Binding{Row: "field", Column: "Message"}
		d.Nodes = []*Node{n}
		if err := d.Validate(); err != nil {
			t.Fatal(source, err)
		}
		n.Binding.Column = "Missing"
		if d.Validate() == nil {
			t.Fatal(source, "accepted a missing column")
		}
	}
	ds.Columns = nil
	ds.Source = "csv"
	if ds.Validate() == nil {
		t.Fatal("CSV without a schema accepted")
	}
	ds.Source = "event_gifts"
	ds.NameColumn = ""
	ds.ImageColumn = ""
	if ds.Validate() != nil || len(ds.Fields()) == 0 {
		t.Fatal("legacy event snapshot unsupported")
	}
}

// A text-only dataset has no source artwork: images here must be the finished documents.
func checkReferencePreviews(t *testing.T, path string, count int) {
	t.Helper()
	out, err := exec.Command("pdfimages", "-list", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	images := 0
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 4 && fields[2] == "image" {
			images++
			if fields[3] != "480" || fields[4] != "320" {
				t.Fatal("preview lost document dimensions", line)
			}
		}
	}
	if images != count {
		t.Fatalf("expected %d document previews, got %d: %s", count, images, out)
	}
}

func TestVariableDataExportOptions(t *testing.T) {
	d := canvasFixture()
	for _, format := range []string{"pdf", "png", "zip", "reference"} {
		if err := (ExportOptions{Format: format}).Validate(d); err != nil {
			t.Fatal(format, err)
		}
	}
	d.Dataset = nil
	for _, format := range []string{"zip", "reference"} {
		if (ExportOptions{Format: format}).Validate(d) == nil {
			t.Fatal("batch export without variable data accepted", format)
		}
	}
	d.Kind = "video"
	d.Duration = 5
	if err := (ExportOptions{Format: "mp4"}).Validate(d); err != nil {
		t.Fatal("template identity overrode document type", err)
	}
}
