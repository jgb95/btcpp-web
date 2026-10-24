package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"btcpp-web/external/getters"
	"btcpp-web/internal/config"
	"btcpp-web/internal/studio"
	"btcpp-web/internal/types"

	"github.com/google/uuid"
	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5"
)

type studioRecord struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Document studio.Document `json:"document"`
	Revision int             `json:"revision"`
	Updated  time.Time       `json:"updated"`
}

func studioJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func studioRead(w http.ResponseWriter, r *http.Request, v any) bool {
	u, e := url.Parse(r.Header.Get("Origin"))
	if e != nil || u.Host != r.Host || (u.Scheme != "https" && u.Scheme != "http") {
		http.Error(w, "Same-origin request required", 403)
		return false
	}
	limitRequestBody(w, r, 32<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(v) != nil || dec.Decode(new(any)) != io.EOF {
		http.Error(w, "Invalid request (maximum 32 MB)", 400)
		return false
	}
	return true
}
func studioLoad(r *http.Request, app *config.AppContext, conf, id string, includeDeleted ...bool) (studioRecord, error) {
	var rec studioRecord
	var raw []byte
	where := " AND deleted_at IS NULL"
	if len(includeDeleted) > 0 && includeDeleted[0] {
		where = " AND deleted_at IS NOT NULL"
	}
	e := app.DB.QueryRow(r.Context(), `SELECT id,name,document,revision,updated_at FROM studio_documents WHERE conference_id=$1 AND id=$2`+where, conf, id).Scan(&rec.ID, &rec.Name, &raw, &rec.Revision, &rec.Updated)
	if e == nil {
		e = json.Unmarshal(raw, &rec.Document)
	}
	return rec, e
}

func ConferenceStudio(w http.ResponseWriter, r *http.Request, app *config.AppContext) {
	StudioDesign(w, r, app)
}

var studioExportSlot = make(chan struct{}, 1)

func StudioDesign(w http.ResponseWriter, r *http.Request, app *config.AppContext) {
	w.Header().Set("Cache-Control", "no-store")
	identity := requireConfAdmin(w, r, app)
	if identity == nil {
		return
	}
	conf, e := getters.GetConfByTag(app, mux.Vars(r)["conf"])
	if e != nil || conf == nil {
		http.NotFound(w, r)
		return
	}
	fail := func(e error) {
		app.Err.Printf("studio: %v", e)
		http.Error(w, "Unable to load or save Studio design", 500)
	}
	id := mux.Vars(r)["id"]
	action := mux.Vars(r)["action"]
	if action == "scene.js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		fmt.Fprint(w, studio.SceneJS)
		return
	}
	if id != "" {
		if _, e = uuid.Parse(id); e != nil {
			http.NotFound(w, r)
			return
		}
	}
	if r.Method == http.MethodPost {
		var in struct {
			Name     string           `json:"name"`
			Template string           `json:"template"`
			Document *studio.Document `json:"document"`
			Revision int              `json:"revision"`
			Format   string           `json:"format"`
		}
		if !studioRead(w, r, &in) {
			return
		}
		if in.Revision < 0 {
			http.Error(w, "Invalid revision", 400)
			return
		}
		if id == "" {
			d, e := studioDefault(app, conf, in.Template)
			if e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
			name := strings.TrimSpace(in.Name)
			if name == "" {
				name = "Sponsor " + in.Template
			}
			if len(name) > 160 {
				http.Error(w, "Name is too long", 400)
				return
			}
			// New designs open template setup before their first explicit save.
			d.NeedsArrange = true
			raw, _ := json.Marshal(d)
			var newID string
			e = app.DB.QueryRow(r.Context(), `INSERT INTO studio_documents(conference_id,name,template,document) VALUES($1,$2,$3,$4) RETURNING id`, conf.Ref, name, d.Template, raw).Scan(&newID)
			if e != nil {
				fail(e)
				return
			}
			studioJSON(w, map[string]string{"url": "/" + conf.Tag + "/admin/studio/designs/" + newID})
			return
		}
		rec, e := studioLoad(r, app, conf.Ref, id, action == "restore")
		if errors.Is(e, pgx.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if e != nil {
			fail(e)
			return
		}
		if in.Revision != rec.Revision {
			http.Error(w, "This design changed in another tab. Your edits are still here; reopen the saved design separately to compare.", 409)
			return
		}
		if action == "delete" || action == "restore" {
			condition, value := "deleted_at IS NULL", "now()"
			if action == "restore" {
				condition, value = "deleted_at IS NOT NULL", "NULL"
			}
			var revision int
			e = app.DB.QueryRow(r.Context(), `UPDATE studio_documents SET deleted_at=`+value+`,revision=revision+1,updated_at=now() WHERE id=$1 AND conference_id=$2 AND revision=$3 AND `+condition+` RETURNING revision`, id, conf.Ref, in.Revision).Scan(&revision)
			if errors.Is(e, pgx.ErrNoRows) {
				http.Error(w, "This design changed in another tab", 409)
				return
			}
			if e != nil {
				fail(e)
				return
			}
			studioJSON(w, map[string]any{"revision": revision, "url": "/" + conf.Tag + "/admin/studio"})
			return
		}
		if action == "prepare-layout" {
			if in.Document == nil || in.Document.Template != rec.Document.Template {
				http.Error(w, "Missing design", 400)
				return
			}
			if e = in.Document.Validate(); e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
			defer cancel()
			if e = studio.Freeze(ctx, in.Document); e != nil {
				http.Error(w, "Artwork: "+e.Error(), 400)
				return
			}
			studioJSON(w, map[string]any{"assets": in.Document.Assets})
			return
		}
		if action == "refresh" {
			d, e := studioDefault(app, conf, rec.Document.Template)
			if e != nil {
				fail(e)
				return
			}
			studioJSON(w, map[string]any{"defaults": d})
			return
		}
		if action == "duplicate" {
			raw, _ := json.Marshal(rec.Document)
			var newID string
			e = app.DB.QueryRow(r.Context(), `INSERT INTO studio_documents(conference_id,name,template,document) VALUES($1,$2,$3,$4) RETURNING id`, conf.Ref, "Copy of "+string([]rune(rec.Name)[:min(len([]rune(rec.Name)), 150)]), rec.Document.Template, raw).Scan(&newID)
			if e != nil {
				fail(e)
				return
			}
			studioJSON(w, map[string]string{"url": "/" + conf.Tag + "/admin/studio/designs/" + newID})
			return
		}
		if action == "export" {
			options := studio.ExportOptions{Format: in.Format}
			if e := options.Validate(rec.Document); e != nil {
				http.Error(w, e.Error(), 400)
				return
			}
			if rec.Document.NeedsArrange {
				http.Error(w, "Arrange and save this design first", 400)
				return
			}
			select {
			case studioExportSlot <- struct{}{}:
				defer func() { <-studioExportSlot }()
			default:
				http.Error(w, "Another Studio export is running. Try again shortly.", 503)
				return
			}
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(6 * time.Minute))
			path, mime, ext, e := studio.RenderWithOptions(r.Context(), rec.Document, options)
			if e != nil {
				app.Err.Printf("studio export: %v", e)
				http.Error(w, "Export failed: "+e.Error(), 500)
				return
			}
			defer os.Remove(path)
			w.Header().Set("Content-Type", mime)
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", conf.Tag+"-"+rec.Document.Template+ext))
			http.ServeFile(w, r, path)
			return
		}
		if in.Document == nil || in.Document.Template != rec.Document.Template {
			http.Error(w, "Missing design", 400)
			return
		}
		if e = in.Document.Validate(); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 160 {
			http.Error(w, "Name must be 1–160 characters", 400)
			return
		}
		if e = studio.Freeze(r.Context(), in.Document); e != nil {
			http.Error(w, "Unable to preserve artwork: "+e.Error(), 400)
			return
		}
		if e = in.Document.Validate(); e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		raw, _ := json.Marshal(in.Document)
		var revision int
		e = app.DB.QueryRow(r.Context(), `UPDATE studio_documents SET name=$1,document=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND conference_id=$4 AND revision=$5 RETURNING revision`, in.Name, raw, id, conf.Ref, in.Revision).Scan(&revision)
		if errors.Is(e, pgx.ErrNoRows) {
			http.Error(w, "This design changed in another tab", 409)
			return
		}
		if e != nil {
			fail(e)
			return
		}
		studioJSON(w, map[string]any{"revision": revision, "document": in.Document})
		return
	}
	if id == "" {
		rows, e := app.DB.Query(r.Context(), `SELECT id,name,document,revision,updated_at FROM studio_documents WHERE conference_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`, conf.Ref)
		if e != nil {
			fail(e)
			return
		}
		defer rows.Close()
		records := []studioRecord{}
		for rows.Next() {
			var rec studioRecord
			var raw []byte
			if e = rows.Scan(&rec.ID, &rec.Name, &raw, &rec.Revision, &rec.Updated); e != nil {
				fail(e)
				return
			}
			if e = json.Unmarshal(raw, &rec.Document); e != nil {
				fail(e)
				return
			}
			records = append(records, rec)
		}
		if e = rows.Err(); e != nil {
			fail(e)
			return
		}
		boot, _ := json.Marshal(records)
		page := struct {
			Conf *types.Conf
			Boot template.JS
		}{conf, template.JS(boot)}
		if e = app.TemplateCache.ExecuteTemplate(w, "admin/studio.tmpl", page); e != nil {
			app.Err.Printf("studio template: %v", e)
		}
		return
	}
	rec, e := studioLoad(r, app, conf.Ref, id)
	if errors.Is(e, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if e != nil {
		fail(e)
		return
	}
	titleChoices := []map[string]string{}
	if rec.Document.Template == "overlay" {
		sponsors, err := getters.ListSponsorships(app, conf.Ref)
		if err != nil {
			fail(err)
			return
		}
		seen := map[string]bool{}
		for _, tier := range groupSponsorTiers(sponsors) {
			if tier.Level != "Title" {
				continue
			}
			for _, sponsor := range tier.Sponsors {
				if seen[sponsor.Org.Ref] {
					continue
				}
				seen[sponsor.Org.Ref] = true
				titleChoices = append(titleChoices, map[string]string{"name": sponsor.Org.Name, "source": studioSponsorSource(sponsor.Org), "sponsor": sponsor.Org.Ref})
			}
		}
	}
	boot, _ := json.Marshal(map[string]any{"record": rec, "titleChoices": titleChoices})
	page := struct {
		Conf *types.Conf
		Boot template.JS
	}{conf, template.JS(boot)}
	if e = app.TemplateCache.ExecuteTemplate(w, "admin/studio_editor.tmpl", page); e != nil {
		app.Err.Printf("studio editor template: %v", e)
	}
}
