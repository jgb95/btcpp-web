package handlers

import (
	"btcpp-web/external/getters"
	"btcpp-web/internal/config"
	"btcpp-web/internal/studio"
	"btcpp-web/internal/types"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

func studioSponsorSource(org *types.Org) string {
	source := org.LogoDark
	if source == "" {
		source = org.LogoLight
	}
	if source != "" && !strings.HasPrefix(source, "/") && !strings.HasPrefix(source, "http") {
		source = "/static/img/sponsors/" + source
	}
	return source
}

func studioImage(d *studio.Document, id, name, source string, x, y, w, h float64) *studio.Node {
	n := studio.Item(id, "image", name)
	n.Asset = d.Asset(source)
	n.X = x
	n.Y = y
	n.Width = w
	n.Height = h
	return n
}
func studioDefault(app *config.AppContext, conf *types.Conf, kind string) (studio.Document, error) {
	if kind != "banner" && kind != "overlay" && kind != "reel" {
		return studio.Document{}, fmt.Errorf("unknown production")
	}
	sponsors, err := getters.ListSponsorships(app, conf.Ref)
	if err != nil {
		return studio.Document{}, err
	}
	var d studio.Document
	switch kind {
	case "banner":
		d = studioBannerTemplate(conf, sponsors)
	case "reel":
		d = studioReelTemplate(conf, sponsors)
	case "overlay":
		d = studioOverlayTemplate(sponsors)
	}
	d.NeedsArrange = kind != "overlay"
	studioTemplateDefaults(&d)
	return d, nil
}

func studioBannerTemplate(conf *types.Conf, sponsors []*types.Sponsorship) studio.Document {
	d := studio.New("banner")
	d.Page.Bleed = 0
	d.Background = studio.Background{Asset: d.Asset(confImagePath(conf.Tag, "leading")), Color: "#111917", Darkness: .5, Bound: true}
	title, dates := strings.ToUpper(conf.Tagline), conf.DateDesc
	if conf.Tag == "berlin26" {
		title = "PAYMENTS EDITION"
	}
	if dates == "" {
		dates = conf.StartDate.Format("2 January") + " – " + conf.EndDate.Format("2 January 2006")
	}
	addText := func(id, name, text string, x, y, size, width, rotation float64, font, color string, binding *studio.Binding) {
		n := studio.Item("text-"+id, "text", name)
		n.Text, n.X, n.Y, n.Rotation, n.Font, n.Color, n.Binding = text, x, y, rotation, font, color, binding
		n.FontSize = math.Min(size, width/math.Max(1, float64(utf8.RuneCountInString(text))*.61))
		d.Nodes = append(d.Nodes, n)
	}
	addText("title", "Edition title", title, 180, 1590, 140, 1400, -90, "BannerMono", "#ffffff", &studio.Binding{Field: "title"})
	addText("wordmark", "bitcoin++", "bitcoin++", 550, 150, 61, 1000, 0, "BannerBrand", "#ffffff", nil)
	// The bottom six inches feed into the roll-up base. Keep the footer above it,
	// with room for text descenders; the background still fills the entire page.
	footer := d.Page.Height - 6*25.4 - 20
	addText("location", "Location", conf.Location, 125, footer-160, 39, 650, 0, "BannerMono", "#ffffff", &studio.Binding{Field: "location"})
	addText("dates", "Dates", dates, 125, footer-105, 39, 650, 0, "BannerMono", "#ffffff", &studio.Binding{Field: "dates"})
	addText("venue", "Venue", conf.Venue, 125, footer-50, 30, 650, 0, "BannerMono", "#ffffff", &studio.Binding{Field: "venue"})
	addText("website", "Website", "btcpp.dev", 125, footer, 39, 650, 0, "BannerMono", "#ffffff", nil)
	tiers := groupSponsorTiers(sponsors)
	for i, tier := range tiers {
		label := strings.ToUpper(tier.Label)
		addText(fmt.Sprintf("tier-%d", i), label, label, 290, 16, 17, 480, 0, "BannerMono", "#d1d1c7", &studio.Binding{Field: "tier-heading:" + tier.Level})
	}
	for i, tier := range tiers {
		g := studio.Item(fmt.Sprintf("tier-%d", i), "group", strings.ToUpper(tier.Label))
		g.Binding = &studio.Binding{Tier: tier.Level}
		g.Columns, g.Weight = 2, 1
		switch tier.Level {
		case "Headline", "Diamond":
			g.Columns, g.Weight = 1, 1.8
		case "Title", "Gold", "Workshop", "Hackathon":
			g.Columns, g.Weight = 1, 1.4
		}
		for j, sponsor := range tier.Sponsors {
			source := studioSponsorSource(sponsor.Org)
			if source == "" {
				continue
			}
			n := studioImage(&d, fmt.Sprintf("logo-%d-%d", i, j), sponsor.Org.Name, source, 0, 0, 0, 0)
			n.Binding = &studio.Binding{Field: "sponsor", Sponsor: sponsor.Org.Ref}
			g.Children = append(g.Children, n)
		}
		d.Nodes = append(d.Nodes, g)
	}
	return d
}

func studioReelTemplate(conf *types.Conf, sponsors []*types.Sponsorship) studio.Document {
	d := studio.New("reel")
	d.Background = studio.Background{Asset: d.Asset(confImagePath(conf.Tag, "leading")), Color: "#111917", Darkness: .5, Bound: true}
	for _, group := range []struct{ id, label string }{{"headline", "Headline sponsors"}, {"title", "Title sponsors"}, {"workshop", "Workshop / hackathon"}, {"silver", "Silver sponsors"}, {"regular", "Regular sponsors"}} {
		n := studio.Item("tier-"+group.id, "group", group.label)
		n.Binding = &studio.Binding{Tier: group.id}
		d.Nodes = append(d.Nodes, n)
	}
	for _, tier := range groupSponsorTiers(sponsors) {
		index := 0
		switch tier.Level {
		case "Headline", "Diamond":
			index = 0
		case "Title":
			index = 1
		case "Workshop", "Hackathon":
			index = 2
		case "Silver":
			index = 3
		case "Bronze", "Networking", "Media", "Community":
			index = 4
		default:
			continue
		}
		g := d.Nodes[index]
		for _, sponsor := range tier.Sponsors {
			source := studioSponsorSource(sponsor.Org)
			if source == "" {
				continue
			}
			n := studioImage(&d, fmt.Sprintf("logo-%d-%d", index, len(g.Children)), sponsor.Org.Name, source, 0, 0, 600, 200)
			n.Binding = &studio.Binding{Field: "sponsor", Sponsor: sponsor.Org.Ref}
			g.Children = append(g.Children, n)
		}
	}
	count := 0
	for _, g := range d.Nodes {
		if len(g.Children) > 0 {
			count++
		}
	}
	step, position := math.Min(.6, 1.6/float64(max(1, count-1))), 0
	for _, g := range d.Nodes {
		if len(g.Children) == 0 {
			continue
		}
		g.Animation = &studio.Timing{Start: math.Round((1+float64(position)*step)*20) / 20, End: 4, Fade: .45, Rise: 60}
		position++
	}
	return d
}

// Template defaults merge lower sponsorship levels; saved designs are unchanged.
func studioTemplateDefaults(d *studio.Document) {
	// Fresh banner artwork has no placement yet. Valid provisional dimensions
	// allow preparation to load originals before the shared fitter sizes them.
	studio.Walk(d.Nodes, func(n *studio.Node) {
		if n.Kind == "image" {
			if n.Width <= 0 {
				n.Width = 160
			}
			if n.Height <= 0 {
				n.Height = 60
			}
		}
	})
	if d.Template == "banner" {
		d.Generation = &studio.Generation{Size: 1, Spacing: 1, NoHeadings: true, BannerReference: true}
		for _, n := range d.Nodes {
			if n.ID == "text-wordmark" {
				n.X = 535
				n.Y = 110
			}
		}
	}
	if d.Template != "banner" {
		return
	}
	lower := map[string]bool{"Bronze": true, "Networking": true, "Media": true, "Community": true}
	var regular *studio.Node
	removed := map[string]bool{}
	for _, n := range d.Nodes {
		if n.Kind != "group" || n.Binding == nil || !lower[n.Binding.Tier] {
			continue
		}
		removed[n.Binding.Tier] = true
		if regular == nil {
			regular = n
		} else {
			regular.Children = append(regular.Children, n.Children...)
		}
	}
	if regular == nil {
		return
	}
	var heading *studio.Node
	out := []*studio.Node{}
	for _, n := range d.Nodes {
		if n.Binding != nil {
			if n.Kind == "group" && lower[n.Binding.Tier] && n != regular {
				continue
			}
			if field, ok := strings.CutPrefix(n.Binding.Field, "tier-heading:"); ok && removed[field] {
				if heading != nil {
					continue
				}
				heading = n
			}
		}
		out = append(out, n)
	}
	regular.Binding.Tier = "regular"
	regular.Name = "Regular sponsors"
	regular.Weight = 1
	regular.Columns = 3
	if heading != nil {
		heading.Binding.Field = "tier-heading:regular"
		heading.Text = "REGULAR SPONSORS"
	}
	d.Nodes = out
}

// New overlays draw from this event's sponsor identities, never hard-coded organizations.
func studioOverlayTemplate(sponsors []*types.Sponsorship) studio.Document {
	d := studio.New("overlay")
	brand := studio.Item("brand-group", "group", "bitcoin++")
	brand.X = 80
	brand.Y = 60
	logo := studioImage(&d, "brand", "bitcoin++", "/static/img/btcpp-logo-white.svg", 0, 0, 300, 77.3)
	logo.Opacity = .66
	brand.Children = append(brand.Children, logo)
	d.Nodes = append(d.Nodes, brand)
	headline := studio.Item("tier-headline", "group", "Headline sponsors")
	headline.Binding = &studio.Binding{Tier: "headline"}
	title := studio.Item("tier-title", "group", "Title sponsor")
	title.Binding = &studio.Binding{Tier: "title"}
	title.X = 80
	title.Y = 60
	for _, tier := range groupSponsorTiers(sponsors) {
		for _, sp := range tier.Sponsors {
			source := studioSponsorSource(sp.Org)
			if source == "" {
				continue
			}
			if tier.Level == "Headline" || tier.Level == "Diamond" {
				n := studioImage(&d, "headline-"+sp.Org.Ref, sp.Org.Name, source, 0, 900, 340, 110)
				n.Binding = &studio.Binding{Sponsor: sp.Org.Ref, Field: "sponsor"}
				n.Opacity = .66
				n.Greyscale = 1
				headline.Children = append(headline.Children, n)
			}
			if tier.Level == "Title" && len(title.Children) == 0 {
				text := studio.Item("powered", "text", "powered by")
				text.Text = "powered by"
				text.Font = "OverlayAeonik"
				text.FontSize = 14
				text.X = 62
				text.Y = 96
				text.Opacity = .66
				n := studioImage(&d, "title", sp.Org.Name, source, 164, 78, 114, 42)
				n.Binding = &studio.Binding{Field: "titleSponsor", Sponsor: sp.Org.Ref}
				n.Opacity = .66
				n.Greyscale = 1
				title.Children = []*studio.Node{text, n}
			}
		}
	}
	for i, n := range headline.Children {
		n.X = 80 + float64(i)*(1720-340)/float64(max(1, len(headline.Children)-1))
		if len(headline.Children) == 1 {
			n.X = 80
		}
		n.Width = min(340, 1720/float64(max(1, len(headline.Children)))-20)
	}
	if len(headline.Children) > 0 {
		d.Nodes = append(d.Nodes, headline)
	}
	if len(title.Children) > 0 {
		d.Nodes = append(d.Nodes, title)
	}
	return d
}
