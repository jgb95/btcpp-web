package studio

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// Dataset stores a reviewed source snapshot, not the artwork of every recipient.
type Dataset struct {
	// Accepted from older open tabs; ignored and discarded on save.
	Acknowledged []string          `json:"acknowledged,omitempty"`
	Source       string            `json:"source"`
	Columns      []string          `json:"columns,omitempty"`
	ImageColumn  string            `json:"imageColumn,omitempty"`
	NameColumn   string            `json:"nameColumn,omitempty"`
	Fingerprint  string            `json:"fingerprint"`
	Rows         []Recipient       `json:"rows"`
	Excluded     []string          `json:"excluded,omitempty"`
	Overrides    map[string]string `json:"overrides,omitempty"`
}
type Recipient struct {
	Values        map[string]string `json:"values,omitempty"`
	IdentityIssue bool              `json:"identityIssue,omitempty"`
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	TalkID        string            `json:"talkId,omitempty"`
	Source        string            `json:"source"`
	Hash          string            `json:"hash,omitempty"`
	Leading       bool              `json:"leading,omitempty"`
	Issue         string            `json:"issue,omitempty"`
	Width         int               `json:"width,omitempty"`
	Height        int               `json:"height,omitempty"`
}

// Fields also reads older saved snapshots which predate explicit column metadata.
func (s *Dataset) Fields() []string {
	if len(s.Columns) > 0 {
		return s.Columns
	}
	seen := map[string]bool{"name": true}
	for _, row := range s.Rows {
		for key := range row.Values {
			seen[key] = true
		}
	}
	fields := make([]string, 0, len(seen))
	for key := range seen {
		fields = append(fields, key)
	}
	sort.Strings(fields)
	return fields
}
func Fingerprint(rows []Recipient) string {
	b, _ := json.Marshal(rows)
	return fmt.Sprintf("%x", sha256.Sum256(b))
}
func (s *Dataset) Validate() error {
	if (s.Source != "event_gifts" && s.Source != "csv") || len(s.Rows) > 200 {
		return fmt.Errorf("variable data supports up to 200 rows")
	}
	if len(s.Columns) > 40 {
		return fmt.Errorf("use at most 40 columns")
	}
	columns := map[string]bool{}
	for _, c := range s.Columns {
		if c == "" || len(c) > 80 || columns[c] {
			return fmt.Errorf("invalid data columns")
		}
		columns[c] = true
	}
	if (s.Source == "csv" || len(s.Columns) > 0) && (!columns[s.NameColumn] || (s.ImageColumn != "" && !columns[s.ImageColumn])) {
		return fmt.Errorf("choose valid data columns")
	}
	ids := map[string]bool{}
	for _, r := range s.Rows {
		if r.ID == "" || len(r.ID) > 160 || ids[r.ID] || strings.TrimSpace(r.Name) == "" || len(r.Name) > 500 || len(r.Issue) > 500 || !validSource(r.Source) {
			return fmt.Errorf("invalid recipient data")
		}
		for k, v := range r.Values {
			if len(k) > 80 || len(v) > 2000 || (len(s.Columns) > 0 && !columns[k]) {
				return fmt.Errorf("invalid row fields")
			}
		}
		ids[r.ID] = true
	}
	seen := map[string]bool{}
	for _, id := range s.Excluded {
		if !ids[id] || seen[id] {
			return fmt.Errorf("invalid row selection")
		}
		seen[id] = true
	}

	for id, source := range s.Overrides {
		if !ids[id] || source == "" || !validSource(source) {
			return fmt.Errorf("invalid recipient artwork override")
		}
	}
	if s.Fingerprint != Fingerprint(s.Rows) {
		return fmt.Errorf("recipient snapshot fingerprint does not match")
	}
	return nil
}
func (s *Dataset) Included() []Recipient {
	excluded := map[string]bool{}
	for _, id := range s.Excluded {
		excluded[id] = true
	}
	rows := []Recipient{}
	for _, r := range s.Rows {
		if !excluded[r.ID] {
			rows = append(rows, r)
		}
	}
	if s.Source == "csv" {
		return rows
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.Leading != b.Leading {
			return !a.Leading
		}
		an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if an != bn {
			return an < bn
		}
		return a.ID < b.ID
	})
	return rows
}
func (s *Dataset) Check(requireArtwork bool) error {
	rows := s.Included()
	if len(rows) == 0 {
		return fmt.Errorf("select at least one recipient")
	}
	for _, r := range rows {
		if requireArtwork && s.Artwork(r) == "" {
			return fmt.Errorf("%s needs artwork", r.Name)
		}
		if requireArtwork && strings.HasPrefix(r.Issue, "Artwork:") && s.Overrides[r.ID] == "" {
			return fmt.Errorf("%s: %s", r.Name, r.Issue)
		}
	}
	return nil
}
func RowValues(r Recipient) map[string]string {
	values := map[string]string{"name": r.Name}
	for k, v := range r.Values {
		values[k] = v
	}
	return values
}
func (s *Dataset) Artwork(r Recipient) string {
	if source := s.Overrides[r.ID]; source != "" {
		return source
	}
	return r.Source
}
func RecipientNumber(i, count int) string {
	return fmt.Sprintf("%0*d", max(2, len(fmt.Sprint(count))), i+1)
}
func RecipientFilename(number, name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '-'
		}
		return r
	}, name)
	name = strings.Join(strings.Fields(name), " ")
	name = strings.Trim(name, " .")
	r := []rune(name)
	shortened := len(r) > 36
	if shortened {
		name = string(r[:36])
	}
	for len(name) > 100 {
		r = []rune(name)
		name = string(r[:len(r)-1])
		shortened = true
	}
	if shortened {
		name = strings.TrimSpace(name) + "…"
	}
	if name == "" {
		name = "Recipient"
	}
	return number + " - " + name + ".pdf"
}

// BindRow only touches a render clone. Saved objects stay bound.
func BindRow(d Document, source, number string, values map[string]string) Document {
	raw, _ := json.Marshal(d)
	var out Document
	json.Unmarshal(raw, &out)
	Walk(out.Nodes, func(n *Node) {
		if n.Binding == nil {
			return
		}
		switch n.Binding.Row {
		case "artwork":
			n.Asset = out.Asset(source)
		case "number":
			n.Text = number
		case "field":
			n.Text = values[n.Binding.Column]
		}
	})
	out.Dataset = nil
	return out
}

// UsesVariableArtwork separates text-only batches from artwork batches.
func (d Document) UsesVariableArtwork() bool {
	found := false
	Walk(d.Nodes, func(n *Node) {
		if n.Binding != nil && n.Binding.Row == "artwork" {
			found = true
		}
	})
	return found
}
