package handlers

import (
	"btcpp-web/internal/types"
	"testing"
)

func TestCanvasSourceIdentityAndOrdering(t *testing.T) {
	a, b := &types.Speaker{ID: "a", Name: "Same"}, &types.Speaker{ID: "b", Name: "Same"}
	talks := []*types.Talk{{ID: "z", Clipart: "z.png", Status: StatusAccepted, Speakers: []*types.Speaker{a}}, {ID: "a", Clipart: "a.png", Status: StatusAccepted, Speakers: []*types.Speaker{a}}, {ID: "panel", Clipart: "panel.png", Status: StatusScheduled, Speakers: []*types.Speaker{b, a}}}
	rows := canvasSourceRows("fixture", talks, []*types.Speaker{a, {ID: "staff", Name: "Staff"}})
	if len(rows) != 3 || rows[0].ID != "a" || rows[0].TalkID != "a" || !rows[0].IdentityIssue || !rows[1].IdentityIssue || !rows[2].Leading {
		t.Fatalf("unexpected rows: %+v", rows)
	}
	other := canvasSourceRows("fixture", []*types.Talk{talks[2], talks[1], talks[0]}, nil)
	if other[0].TalkID != rows[0].TalkID {
		t.Fatal("talk choice depends on database ordering")
	}
}
func TestCanvasTemplateGeometry(t *testing.T) {
	d := studioCanvasTemplate(&types.Conf{Tag: "fixture"})
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if d.Page.Width != 13 || d.Page.Height != 11.5 || d.Page.Unit != "in" {
		t.Fatal(d.Page)
	}
	art, brand, guide, number := d.Nodes[0], d.Nodes[1], d.Nodes[2], d.Nodes[3]
	if art.Width != 10.75 || art.Height != 10.75 || art.Y != .75 || !guide.Locked || number.TextAlign != "right" || number.FontSize*72 != 6 || number.X != 11.375 || number.Y != .25 || brand.Binding != nil {
		t.Fatal("print geometry changed")
	}
	if len(d.Nodes) != 4 || number.Binding.Row != "number" || art.Binding.Row != "artwork" {
		t.Fatal("unexpected canvas objects")
	}
}
