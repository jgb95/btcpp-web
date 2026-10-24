package handlers

import (
	"fmt"
	"testing"

	"btcpp-web/internal/studio"
	"btcpp-web/internal/types"
)

func TestStudioTemplateRegularSponsors(t *testing.T) {
	d := studio.New("banner")
	for _, level := range []string{"Headline", "Silver", "Bronze", "Media", "Community"} {
		h := studio.Item("heading-"+level, "text", level)
		h.Binding = &studio.Binding{Field: "tier-heading:" + level}
		g := studio.Item("tier-"+level, "group", level)
		g.Binding = &studio.Binding{Tier: level}
		g.Children = []*studio.Node{studio.Item("logo-"+level, "image", level)}
		d.Nodes = append(d.Nodes, h, g)
	}
	studioTemplateDefaults(&d)
	count, headings := 0, 0
	for _, n := range d.Nodes {
		if n.Binding.Tier == "regular" {
			count++
			if len(n.Children) != 3 {
				t.Fatal("lower-tier logos were lost")
			}
		}
		if n.Binding.Field == "tier-heading:regular" {
			headings++
			if n.Text != "REGULAR SPONSORS" {
				t.Fatal("wrong regular heading")
			}
		}
		if n.Binding.Tier == "Media" || n.Binding.Tier == "Community" {
			t.Fatal("lower tiers remain separate")
		}
	}
	if count != 1 || headings != 1 || len(d.Nodes) != 6 {
		t.Fatalf("unexpected template groups: %d %d %d", count, headings, len(d.Nodes))
	}
}

func TestStudioOverlayUsesEventSponsors(t *testing.T) {
	empty := studioOverlayTemplate(nil)
	if len(empty.Nodes) != 1 {
		t.Fatal("empty event got hard-coded sponsors")
	}
	if e := empty.Validate(); e != nil {
		t.Fatal(e)
	}
	sponsors := []*types.Sponsorship{}
	for _, level := range []string{"Headline", "Title", "Silver"} {
		sponsors = append(sponsors, &types.Sponsorship{Level: level, Status: "Paid", Org: &types.Org{Ref: level, Name: level, LogoDark: "logo.svg"}})
	}
	d := studioOverlayTemplate(sponsors)
	if e := d.Validate(); e != nil {
		t.Fatal(e)
	}
	names := map[string]bool{}
	studio.Walk(d.Nodes, func(n *studio.Node) { names[n.Name] = true })
	if names["Silver"] || !names["Headline"] || !names["Title"] || !names["powered by"] {
		t.Fatal(names)
	}
	without := studioOverlayTemplate(sponsors[:1])
	names = map[string]bool{}
	studio.Walk(without.Nodes, func(n *studio.Node) { names[n.Name] = true })
	if names["powered by"] {
		t.Fatal("powered by shown without a title sponsor")
	}
}

func TestStudioDirectTemplates(t *testing.T) {
	conf := &types.Conf{Tag: "dev26", Tagline: "Development", Location: "Test city", DateDesc: "1–2 May 2026", Venue: "Test venue"}
	for _, count := range []int{0, 1, 40} {
		for _, kind := range []string{"banner", "overlay", "reel"} {
			t.Run(fmt.Sprintf("%s/%d", kind, count), func(t *testing.T) {
				sponsors := []*types.Sponsorship{}
				for i := 0; i < count; i++ {
					level := []string{"Headline", "Workshop", "Silver", "Bronze", "Community"}[i%5]
					sponsors = append(sponsors, &types.Sponsorship{Level: level, Status: "Paid", Org: &types.Org{Ref: fmt.Sprintf("org-%d", i), Name: "Shared display name", LogoDark: "logo.svg"}})
				}
				var d studio.Document
				switch kind {
				case "banner":
					d = studioBannerTemplate(conf, sponsors)
				case "overlay":
					d = studioOverlayTemplate(sponsors)
				case "reel":
					d = studioReelTemplate(conf, sponsors)
				}
				studioTemplateDefaults(&d)
				if err := d.Validate(); err != nil {
					t.Fatal(err)
				}
				found := map[string]bool{}
				studio.Walk(d.Nodes, func(n *studio.Node) {
					if n.Binding != nil && n.Binding.Sponsor != "" {
						found[n.Binding.Sponsor] = true
					}
				})
				expected := count
				if kind == "overlay" {
					expected = (count + 4) / 5
				}
				if len(found) != expected {
					t.Fatalf("sponsor identities lost: got %d want %d", len(found), expected)
				}
				if kind == "banner" && (d.Page.Bleed != 0 || d.Generation == nil || !d.Generation.NoHeadings) {
					t.Fatal("banner defaults changed")
				}
				if kind == "reel" {
					first := -1.0
					for _, g := range d.Nodes {
						if len(g.Children) == 0 {
							if g.Animation != nil {
								t.Fatal("empty tier has animation")
							}
							continue
						}
						if first < 0 {
							first = g.Animation.Start
						}
						if g.Animation.End != d.Duration-1 {
							t.Fatal("outro changed")
						}
					}
					if count > 0 && first != 1 {
						t.Fatal("intro changed")
					}
				}
			})
		}
	}
}
