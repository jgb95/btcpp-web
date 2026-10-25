package handlers

import (
	"btcpp-web/internal/types"
	"sort"
	"strings"
)

// Keep legacy talks without proposal status, as on the conference schedule.
func giftTalkEligible(talk *types.Talk) bool {
	if talk == nil {
		return false
	}
	switch talk.Status {
	case "", StatusAccepted, StatusScheduled:
		return true
	default:
		return false
	}
}

type giftSelection struct {
	ID, Name, Clipart, TalkID string
	PanelN                    int
}

func giftSelections(talks []*types.Talk, staff []*types.Speaker) []giftSelection {
	best := map[string]giftSelection{}
	key := func(sp *types.Speaker) string {
		if sp.ID != "" {
			return sp.ID
		}
		return "name:" + strings.ToLower(strings.TrimSpace(sp.Name))
	}
	for _, talk := range talks {
		if !giftTalkEligible(talk) {
			continue
		}
		for _, sp := range talk.Speakers {
			if sp == nil {
				continue
			}
			id := key(sp)
			prev, ok := best[id]
			hasArt := strings.TrimSpace(talk.Clipart) != ""
			prevArt := strings.TrimSpace(prev.Clipart) != ""
			if !ok || (hasArt && !prevArt) || (hasArt == prevArt && (len(talk.Speakers) < prev.PanelN || (len(talk.Speakers) == prev.PanelN && talk.ID < prev.TalkID))) {
				best[id] = giftSelection{id, sp.Name, talk.Clipart, talk.ID, len(talk.Speakers)}
			}
		}
	}
	for _, sp := range staff {
		if sp == nil {
			continue
		}
		id := key(sp)
		if _, ok := best[id]; !ok {
			best[id] = giftSelection{ID: id, Name: sp.Name, Clipart: "leading.png"}
		}
	}
	rows := make([]giftSelection, 0, len(best))
	for _, r := range best {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := strings.ToLower(rows[i].Name), strings.ToLower(rows[j].Name)
		if a == b {
			return rows[i].ID < rows[j].ID
		}
		return a < b
	})
	return rows
}
func speakerGiftRows(talks []*types.Talk, staff []*types.Speaker) []*GiftRow {
	rows := []*GiftRow{}
	for _, r := range giftSelections(talks, staff) {
		rows = append(rows, &GiftRow{Clipart: r.Clipart, SpeakerName: r.Name})
	}
	return rows
}
