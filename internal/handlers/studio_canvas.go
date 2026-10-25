package handlers

import (
	"btcpp-web/external/getters"
	"btcpp-web/internal/auth"
	"btcpp-web/internal/config"
	"btcpp-web/internal/studio"
	"btcpp-web/internal/types"
	"context"
	"fmt"
	"os"
	"strings"
)

func canvasEventImage(tag, base string) string {
	source := "/static/img/" + tag + "/" + base + ".png"
	if _, err := os.Stat(strings.TrimPrefix(source, "/")); err == nil {
		return source
	}
	return confImagePath(tag, base)
}
func studioCanvasTemplate(conf *types.Conf) studio.Document {
	d := studio.New("canvas")
	d.Dataset = &studio.Dataset{Source: "event_gifts", Rows: []studio.Recipient{}}
	d.Dataset.Fingerprint = studio.Fingerprint(d.Dataset.Rows)
	d.Page = studio.Page{Width: 13, Height: 11.5, Unit: "in"}
	d.Background.Color = "#ffffff"
	placeholder := "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNlNWU1ZTUiLz48L3N2Zz4="
	art := studioImage(&d, "canvas-artwork", "Recipient artwork", placeholder, 0, .75, 10.75, 10.75)
	art.Binding = &studio.Binding{Row: "artwork"}
	source := canvasEventImage(conf.Tag, "logo")
	if source == "" {
		source = "/static/img/btcpp-logo-black.svg"
	}
	brand := studioImage(&d, "canvas-branding", "Event branding", source, 6.152, 8.45, 2.75, 1.375)
	guide := studioImage(&d, "canvas-guide", "Print guide", "/static/img/studio/canvas-guide.svg", -.75, 0, 12.25, 12.25)
	guide.Locked = true
	number := studio.Item("canvas-number", "text", "Recipient number")
	number.Text = "01"
	number.X = 11.375
	number.Y = .25
	number.FontSize = 6. / 72
	number.Color = "#000000"
	number.TextAlign = "right"
	number.Binding = &studio.Binding{Row: "number"}
	d.Nodes = []*studio.Node{art, brand, guide, number}
	return d
}
func canvasSourceRows(tag string, talks []*types.Talk, staff []*types.Speaker) []studio.Recipient {
	rows := []studio.Recipient{}
	names := map[string]int{}
	for _, r := range giftSelections(talks, staff) {
		names[strings.ToLower(strings.TrimSpace(r.Name))]++
	}
	for _, r := range giftSelections(talks, staff) {
		row := studio.Recipient{ID: r.ID, Name: r.Name, TalkID: r.TalkID, Leading: r.Clipart == "leading.png"}
		if r.Clipart != "" {
			if row.Leading {
				row.Source = canvasEventImage(tag, "leading")
			} else {
				row.Source = "https://btcpp.nyc3.digitaloceanspaces.com/talks/" + r.Clipart
			}
		}
		if names[strings.ToLower(strings.TrimSpace(r.Name))] > 1 || strings.HasPrefix(r.ID, "name:") {
			row.IdentityIssue = true
			row.Issue = "Confirm recipient identity; display name is not unique or has no person ID"
		}
		rows = append(rows, row)
	}
	return rows
}
func studioCanvasData(ctx context.Context, app *config.AppContext, conf *types.Conf) (*studio.Dataset, map[string]studio.Artwork, error) {
	talks, err := getters.GetTalksFor(app, conf.Tag)
	if err != nil {
		return nil, nil, err
	}
	staff, err := getters.ListSpeakersWithRole(app, strings.ToLower(conf.Tag)+"-"+auth.RoleStaff)
	if err != nil {
		return nil, nil, fmt.Errorf("load staff: %w", err)
	}
	rows := canvasSourceRows(conf.Tag, talks, staff)
	for i := range rows {
		rows[i].Values = eventDataValues(conf, rows[i].Name)
	}
	if len(rows) > 200 {
		return nil, nil, fmt.Errorf("canvas gifts support up to 200 recipients")
	}
	rows = (&studio.Dataset{Rows: rows}).Included()
	assets, err := studio.MeasureRows(ctx, rows, true)
	if err != nil {
		return nil, nil, err
	}
	data := &studio.Dataset{Source: "event_gifts", Rows: rows, NameColumn: "name", ImageColumn: "artwork", Fingerprint: studio.Fingerprint(rows)}
	data.Columns = append(data.Fields(), "artwork")
	return data, assets, data.Validate()
}

func eventDataValues(conf *types.Conf, name string) map[string]string {
	return map[string]string{"name": name, "event.name": conf.Desc, "event.tag": conf.Tag, "event.location": conf.Location, "event.dates": conf.DateDesc, "event.venue": conf.Venue}
}
