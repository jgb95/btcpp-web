// Package studio contains the common document and renderer for event productions.
package studio

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type Page struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Unit   string  `json:"unit"`
	Bleed  float64 `json:"bleed"`
}
type Background struct {
	Asset    string  `json:"asset"`
	Color    string  `json:"color"`
	Darkness float64 `json:"darkness"`
	Bound    bool    `json:"bound"`
	X        float64 `json:"x,omitempty"`
	Y        float64 `json:"y,omitempty"`
	Zoom     float64 `json:"zoom,omitempty"`
}
type Timing struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Fade  float64 `json:"fade"`
	Rise  float64 `json:"rise"`
}
type Binding struct {
	Field   string `json:"field,omitempty"`
	Sponsor string `json:"sponsor,omitempty"`
	Tier    string `json:"tier,omitempty"`
}
type Node struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Name       string   `json:"name"`
	X          float64  `json:"x"`
	Y          float64  `json:"y"`
	Width      float64  `json:"width"`
	Height     float64  `json:"height"`
	Scale      float64  `json:"scale"`
	Rotation   float64  `json:"rotation"`
	Opacity    float64  `json:"opacity"`
	Hidden     bool     `json:"hidden"`
	Locked     bool     `json:"locked"`
	Asset      string   `json:"asset,omitempty"`
	Text       string   `json:"text,omitempty"`
	Font       string   `json:"font,omitempty"`
	FontSize   float64  `json:"fontSize,omitempty"`
	Color      string   `json:"color,omitempty"`
	Greyscale  float64  `json:"greyscale"`
	Brightness float64  `json:"brightness"`
	White      bool     `json:"white,omitempty"`
	Fit        string   `json:"fit,omitempty"`
	Binding    *Binding `json:"binding,omitempty"`
	Animation  *Timing  `json:"animation,omitempty"`
	Children   []*Node  `json:"children,omitempty"`
	Columns    int      `json:"columns,omitempty"`
	Weight     float64  `json:"weight,omitempty"`
}

// ArtworkBounds is the visible portion of an original, in normalized coordinates.
type ArtworkBounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type Generation struct {
	Size            float64 `json:"size"`
	Spacing         float64 `json:"spacing"`
	NoHeadings      bool    `json:"noHeadings,omitempty"`
	BannerReference bool    `json:"bannerReference,omitempty"`
}
type Document struct {
	ArtworkBounds map[string]ArtworkBounds `json:"artworkBounds,omitempty"`
	Generation    *Generation              `json:"generation,omitempty"`

	Version      int               `json:"version"`
	Template     string            `json:"template"`
	Kind         string            `json:"kind,omitempty"`
	Page         Page              `json:"page"`
	Background   Background        `json:"background"`
	Duration     float64           `json:"duration"`
	Assets       map[string]string `json:"assets"`
	Nodes        []*Node           `json:"nodes"`
	NeedsArrange bool              `json:"needsArrange,omitempty"`
}

var Fonts = map[string]string{"BannerMono": "CourierPrime-Regular.ttf", "BannerBrand": "Ubuntu-BoldItalic.ttf", "BannerMarker": "PermanentMarker-Regular.ttf", "OverlayAeonik": "AeonikTRIAL-Regular.otf"}

func New(kind string) Document {
	d := Document{Version: 1, Template: kind, Page: Page{1920, 1080, "px", 0}, Background: Background{Color: "#111917"}, Assets: map[string]string{}, Nodes: []*Node{}}
	if kind == "banner" {
		d.Page = Page{850, 2030, "mm", 3}
	}
	if kind == "overlay" {
		d.Background.Color = "transparent"
	}
	if kind == "reel" {
		d.Duration = 5
	}
	return d
}
func Item(id, kind, name string) *Node {
	return &Node{ID: id, Kind: kind, Name: name, Scale: 1, Opacity: 1, Brightness: 1, Color: "#ffffff", Font: "BannerMono", FontSize: 32}
}
func (d *Document) Asset(source string) string {
	if source == "" {
		return ""
	}
	id := fmt.Sprintf("a%x", sha256.Sum256([]byte(source)))
	d.Assets[id] = source
	return id
}
func Walk(nodes []*Node, f func(*Node)) {
	for _, n := range nodes {
		f(n)
		Walk(n.Children, f)
	}
}
func color(s string) bool {
	return len(s) == 7 && s[0] == '#' && strings.Trim(s[1:], "0123456789abcdefABCDEF") == ""
}
func finite(v, lo, hi float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= lo && v <= hi }
func (d Document) Validate() error {
	bad := func() error { return fmt.Errorf("invalid Studio document") }
	if d.Version != 1 || (d.Template != "banner" && d.Template != "overlay" && d.Template != "reel") {
		return bad()
	}
	if d.Template == "overlay" && d.Kind == "" && (d.Background.Color != "transparent" || d.Background.Asset != "" || d.Background.Darkness != 0) {
		return fmt.Errorf("overlay backgrounds are preview-only until explicitly changed in Document setup")
	}
	if d.Kind != "" && d.Kind != "print" && d.Kind != "graphic" && d.Kind != "video" {
		return bad()
	}
	if d.Page.Unit != "px" && d.Page.Unit != "mm" && d.Page.Unit != "in" {
		return fmt.Errorf("choose px, mm, or in")
	}
	if !finite(d.Page.Width, .1, 10000) || !finite(d.Page.Height, .1, 10000) || !finite(d.Page.Bleed, 0, 100) {
		return fmt.Errorf("invalid canvas dimensions")
	}
	w, h := d.PixelSize()
	if w < 16 || h < 16 || w > 8192 || h > 8192 || w*h > 32000000 {
		return fmt.Errorf("canvas must be 16–8192 pixels per side, at most 32 megapixels")
	}
	if d.Type() == "video" && (d.Page.Unit != "px" || d.Page.Bleed != 0 || int(w)%2 != 0 || int(h)%2 != 0 || w != math.Trunc(w) || h != math.Trunc(h) || w > 4096 || h > 4096) {
		return fmt.Errorf("video needs even whole-pixel dimensions up to 4096 and no bleed")
	}
	if d.Duration != 0 || d.Type() == "video" {
		if !finite(d.Duration, 2, 30) || math.Abs(d.Duration*30-math.Round(d.Duration*30)) > .00001 {
			return fmt.Errorf("duration must be 2–30 seconds in whole frames")
		}
	}

	if !finite(d.Background.X, -10000, 10000) || !finite(d.Background.Y, -10000, 10000) || (d.Background.Zoom != 0 && !finite(d.Background.Zoom, 1, 8)) {
		return fmt.Errorf("invalid background placement")
	}
	if d.Generation != nil && (!finite(d.Generation.Size, .7, 1.3) || !finite(d.Generation.Spacing, .5, 1.5)) {
		return fmt.Errorf("invalid layout settings")
	}
	if len(d.ArtworkBounds) > 500 {
		return bad()
	}
	for id, b := range d.ArtworkBounds {
		if d.Assets[id] == "" || !finite(b.X, 0, 1) || !finite(b.Y, 0, 1) || !finite(b.Width, .000001, 1) || !finite(b.Height, .000001, 1) || b.X+b.Width > 1.000001 || b.Y+b.Height > 1.000001 {
			return fmt.Errorf("invalid artwork bounds")
		}
	}
	if len(d.Assets) > 500 || !finite(d.Background.Darkness, 0, 1) || (!color(d.Background.Color) && d.Background.Color != "transparent") {
		return bad()
	}
	for k, s := range d.Assets {
		if len(k) > 100 || s == "" || !validSource(s) {
			return fmt.Errorf("unsupported artwork")
		}
	}
	if d.Background.Asset != "" && d.Assets[d.Background.Asset] == "" {
		return fmt.Errorf("background artwork missing")
	}
	seen := map[string]bool{}
	count := 0
	var check func([]*Node, int) error
	check = func(nodes []*Node, depth int) error {
		if depth > 8 {
			return fmt.Errorf("groups are nested too deeply")
		}
		for _, n := range nodes {
			count++
			if n == nil || count > 500 {
				return bad()
			}
			if n.ID == "" || len(n.ID) > 100 || seen[n.ID] || len(n.Name) > 160 {
				return bad()
			}
			seen[n.ID] = true
			if !finite(n.X, -10000, 10000) || !finite(n.Y, -10000, 10000) || !finite(n.Width, 0, 10000) || !finite(n.Height, 0, 10000) || !finite(n.Scale, .001, 100) || !finite(n.Rotation, -360, 360) || !finite(n.Opacity, 0, 1) || !finite(n.Greyscale, 0, 1) || !finite(n.Brightness, 0, 2) {
				return bad()
			}
			switch n.Kind {
			case "image":
				if n.Width <= 0 || n.Height <= 0 || d.Assets[n.Asset] == "" {
					return fmt.Errorf("%s needs artwork", n.Name)
				}
			case "text":
				if _, ok := Fonts[n.Font]; !ok {
					return fmt.Errorf("choose a bundled font")
				}
				size := n.FontSize
				if d.Page.Unit == "mm" {
					size *= 96 / 25.4
				} else if d.Page.Unit == "in" {
					size *= 96
				}
				if len(n.Text) > 8000 || !finite(size, .05, 10000) || !color(n.Color) {
					return bad()
				}
			case "group":
			default:
				return bad()
			}
			if n.Kind != "group" && len(n.Children) > 0 {
				return bad()
			}
			if n.Binding != nil && (len(n.Binding.Field) > 80 || len(n.Binding.Sponsor) > 100 || len(n.Binding.Tier) > 120) {
				return bad()
			}
			if n.Animation != nil {
				a := n.Animation
				if d.Duration < 2 || !finite(a.Start, 0, d.Duration) || !finite(a.End, a.Start, d.Duration) || !finite(a.Fade, 0, 3) || !finite(a.Rise, 0, 300) || a.Start+2*a.Fade > a.End+.00001 {
					return fmt.Errorf("animation needs room for its entrance and exit")
				}
			}
			if err := check(n.Children, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := check(d.Nodes, 0); err != nil {
		return err
	}
	raw, _ := json.Marshal(d)
	if len(raw) > 32<<20 {
		return fmt.Errorf("document exceeds 32 MB")
	}
	return nil
}

// Template identifies the starting composition; Type controls editing and export.
func (d Document) Type() string {
	if d.Kind == "print" { // Older documents use the same graphic editing and export options.
		return "graphic"
	}
	if d.Kind != "" {
		return d.Kind
	}
	return map[string]string{"banner": "graphic", "overlay": "graphic", "reel": "video"}[d.Template]
}
func (d Document) PixelSize() (float64, float64) {
	f := 1.0
	if d.Page.Unit == "mm" {
		f = 96 / 25.4
	} else if d.Page.Unit == "in" {
		f = 96
	}
	return (d.Page.Width + 2*d.Page.Bleed) * f, (d.Page.Height + 2*d.Page.Bleed) * f
}
