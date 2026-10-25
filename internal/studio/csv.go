package studio

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// PrepareCSV accepts data, never local file paths. Artwork uses the same bounded loader as Studio.
func PrepareCSV(ctx context.Context, raw, nameColumn, imageColumn string) (*Dataset, error) {
	if !utf8.ValidString(raw) {
		return nil, fmt.Errorf("CSV must use UTF-8 encoding")
	}
	if len(raw) > 1<<20 {
		return nil, fmt.Errorf("CSV exceeds 1 MB")
	}
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(raw, "\ufeff")))
	header, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("read CSV header: %w", err)
	}
	if len(header) == 0 || len(header) > 40 {
		return nil, fmt.Errorf("use 1–40 CSV columns")
	}
	seen := map[string]bool{}
	for i, c := range header {
		c = strings.TrimSpace(c)
		if c == "" || len(c) > 80 || seen[c] {
			return nil, fmt.Errorf("CSV headers must be unique, nonempty, and at most 80 characters")
		}
		header[i] = c
		seen[c] = true
	}
	if nameColumn == "" {
		nameColumn = header[0]
		for _, c := range header {
			if strings.EqualFold(c, "name") {
				nameColumn = c
			}
		}
	}
	if imageColumn == "auto" {
		imageColumn = ""
		for _, c := range header {
			switch strings.ToLower(strings.TrimPrefix(c, "@")) {
			case "photo", "image", "artwork":
				imageColumn = c
			}
		}
	}
	if !seen[nameColumn] || (imageColumn != "" && !seen[imageColumn]) {
		return nil, fmt.Errorf("choose valid name and artwork columns")
	}
	ds := &Dataset{Source: "csv", Columns: header, NameColumn: nameColumn, ImageColumn: imageColumn, Rows: []Recipient{}}
	ids := map[string]bool{}
	occurrences := map[string]int{}
	for {
		cells, e := r.Read()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, fmt.Errorf("CSV row %d: %w", len(ds.Rows)+2, e)
		}
		if len(ds.Rows) >= 200 {
			return nil, fmt.Errorf("CSV supports at most 200 rows")
		}
		values := map[string]string{}
		for i, c := range cells {
			if len(c) > 2000 {
				return nil, fmt.Errorf("CSV cells must be at most 2000 bytes")
			}
			values[header[i]] = c
		}
		row := Recipient{Name: strings.TrimSpace(values[nameColumn]), Source: strings.TrimSpace(values[imageColumn]), Values: values}
		if row.Name == "" {
			row.Name = fmt.Sprintf("Row %d", len(ds.Rows)+1)
		}
		for _, c := range header {
			if strings.EqualFold(c, "id") {
				row.ID = strings.TrimSpace(values[c])
			}
		}
		if row.ID == "" {
			hash := Fingerprint([]Recipient{row})
			occurrences[hash]++
			row.ID = fmt.Sprintf("csv:%s:%d", hash, occurrences[hash])
		}
		if ids[row.ID] {
			return nil, fmt.Errorf("CSV IDs must be unique: %s", row.ID)
		}
		ids[row.ID] = true
		// Invalid/missing artwork is reviewable and replaceable; other row data remains usable.
		if row.Source != "" && !validSource(row.Source) {
			row.Issue = "Artwork: use an allowed Studio artwork URL or replace the image"
			row.Source = ""
		}
		ds.Rows = append(ds.Rows, row)
	}
	if len(ds.Rows) == 0 {
		return nil, fmt.Errorf("CSV has no data rows")
	}
	if _, err = MeasureRows(ctx, ds.Rows, imageColumn != ""); err != nil {
		return nil, err
	}
	ds.Fingerprint = Fingerprint(ds.Rows)
	return ds, ds.Validate()
}
