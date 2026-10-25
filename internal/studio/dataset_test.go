package studio

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func canvasFixture() Document {
	d := New("canvas")
	d.Page = Page{Width: 13, Height: 11.5, Unit: "in"}
	d.Background.Color = "#ffffff"
	art := Item("art", "image", "Artwork")
	art.X, art.Y, art.Width, art.Height = 0, .75, 10.75, 10.75
	art.Asset = d.Asset("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path fill="orange" d="M0 0h1024v1024H0z"/></svg>`)))
	art.Binding = &Binding{Row: "artwork"}
	number := Item("number", "text", "Number")
	number.Text = "01"
	number.X, number.Y, number.FontSize, number.TextAlign = 11.375, .25, 6./72, "right"
	number.Color = "#000000"
	number.Binding = &Binding{Row: "number"}
	d.Nodes = []*Node{art, number}
	d.Dataset = &Dataset{Source: "event_gifts", Rows: []Recipient{{ID: "b", Name: "Ben", Source: d.Assets[art.Asset]}, {ID: "a", Name: "Adam", Source: d.Assets[art.Asset]}, {ID: "staff", Name: "Aaron", Source: d.Assets[art.Asset], Leading: true}}}
	d.Dataset.Fingerprint = Fingerprint(d.Dataset.Rows)
	return d
}
func TestCanvasDatasetAndBindings(t *testing.T) {
	d := canvasFixture()
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := d.Dataset.Check(true); err != nil {
		t.Fatal(err)
	}
	rows := d.Dataset.Included()
	if rows[0].ID != "a" || rows[2].ID != "staff" {
		t.Fatal("wrong recipient ordering", rows)
	}
	original, _ := json.Marshal(d)
	preview := BindRow(d, rows[0].Source, "07", nil)
	after, _ := json.Marshal(d)
	if string(original) != string(after) || preview.Nodes[1].Text != "07" || preview.Dataset != nil {
		t.Fatal("preview mutated template")
	}
	if err := preview.Validate(); err != nil {
		t.Fatal(err)
	}
	d.Dataset.Excluded = []string{"a"}
	if len(d.Dataset.Included()) != 2 {
		t.Fatal("exclusion lost")
	}
	d.Dataset.Rows[0].IdentityIssue = true
	d.Dataset.Rows[0].Issue = "Confirm identity"
	if err := d.Dataset.Check(true); err != nil {
		t.Fatal(err)
	}
	d.Dataset.Rows[0].Issue = "Artwork: missing"
	if d.Dataset.Check(true) == nil {
		t.Fatal("missing artwork accepted")
	}
	d.Dataset.Overrides = map[string]string{"b": rows[0].Source}
	if err := d.Dataset.Check(true); err != nil {
		t.Fatal(err)
	}
	if RecipientFilename("01", `../A/B:李 🎉`) != "01 - -A-B-李 🎉.pdf" {
		t.Fatal(RecipientFilename("01", `../A/B:李 🎉`))
	}
	if RecipientNumber(0, 100) != "001" {
		t.Fatal("number padding")
	}
	d.Dataset.Fingerprint = "stale"
	if d.Validate() == nil {
		t.Fatal("invalid source fingerprint accepted")
	}
}
func TestCanvasRealPackage(t *testing.T) {
	if os.Getenv("STUDIO_RENDER_TEST") == "" {
		t.Skip("set STUDIO_RENDER_TEST=1")
	}
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir("internal/studio")
	d := canvasFixture()
	d.Dataset.Rows[0].Name = strings.Repeat("김李", 40)
	d.Dataset.Fingerprint = Fingerprint(d.Dataset.Rows)
	a, err := InspectArtwork(context.Background(), d.Dataset.Rows[0].Source)
	if err != nil {
		t.Fatal(err)
	}
	path, err := RenderDataset(context.Background(), d, map[string]Artwork{d.Dataset.Rows[0].Source: a}, "fixture", "design", 4, "", "zip")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	if len(zr.File) != 5 {
		t.Fatal("wrong ZIP entries", len(zr.File))
	}
	dir := t.TempDir()
	for _, f := range zr.File {
		r, _ := f.Open()
		data, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		if f.Name == "manifest.json" {
			var m DatasetManifest
			if err = json.Unmarshal(data, &m); err != nil {
				t.Fatal(err)
			}
			if len(m.Recipients) != 3 || m.Recipients[0].Number != "01" || m.Recipients[0].Name != "Adam" || m.Recipients[2].Name != "Aaron" || m.ReferenceHash == "" {
				t.Fatal(m)
			}
			continue
		}
		name := filepath.Join(dir, filepath.Base(f.Name))
		os.WriteFile(name, data, 0600)
		info, e := exec.Command("pdfinfo", name).CombinedOutput()
		if e != nil {
			t.Fatal(string(info), e)
		}
		if strings.HasPrefix(f.Name, "pdf/") && !strings.Contains(string(info), "936 x 828") {
			t.Fatal("wrong canvas size", string(info))
		}
		if strings.HasPrefix(f.Name, "pdf/") {
			text, e := exec.Command("pdftotext", name, "-").CombinedOutput()
			if e != nil {
				t.Fatal(e)
			}
			if strings.Contains(string(text), "Adam") || !strings.Contains(string(text), strings.Split(filepath.Base(f.Name), " ")[0]) {
				t.Fatal("wrong printed number/name", string(text))
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if path, err := RenderDataset(ctx, d, nil, "fixture", "design", 4, "a", "pdf"); err == nil {
		os.Remove(path)
		t.Fatal("cancelled export succeeded")
	}
}

func TestCanvasResolutionFollowsGroupScale(t *testing.T) {
	d := canvasFixture()
	d.Nodes[0].Width, d.Nodes[0].Height = 10, 10
	a := Artwork{Width: 1000, Height: 500}
	if got := ArtworkPPI(d, a); got != 100 {
		t.Fatal(got)
	}
	parent := Item("group", "group", "Group")
	parent.Scale = 2
	parent.Children = []*Node{d.Nodes[0]}
	d.Nodes[0] = parent
	if got := ArtworkPPI(d, a); got != 50 {
		t.Fatal(got)
	}
	d.Page.Unit = "mm"
	parent.Children[0].Width, parent.Children[0].Height = 254, 254
	if got := ArtworkPPI(d, a); got != 50 {
		t.Fatal(got)
	}
}

func TestDuplicateNamesUseManualInclusion(t *testing.T) {
	d := canvasFixture()
	d.Dataset.Rows = d.Dataset.Rows[:2]
	for i := range d.Dataset.Rows {
		d.Dataset.Rows[i].Name = "Dan Gould"
		d.Dataset.Rows[i].IdentityIssue = true
	}
	d.Dataset.Fingerprint = Fingerprint(d.Dataset.Rows)
	if err := d.Dataset.Check(true); err != nil {
		t.Fatal("name warning blocked deliberate inclusion", err)
	}
	d.Dataset.Excluded = []string{d.Dataset.Rows[1].ID}
	if len(d.Dataset.Included()) != 1 || d.Dataset.Check(true) != nil {
		t.Fatal("manual duplicate exclusion failed")
	}
}
