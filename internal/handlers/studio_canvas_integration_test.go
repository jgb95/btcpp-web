package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"

	"btcpp-web/internal/auth"
	"btcpp-web/internal/config"
	"btcpp-web/internal/studio"
	"btcpp-web/internal/types"
	"github.com/alexedwards/scs/v2"
	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStudioCanvasPreviewScopeAndChanges(t *testing.T) {
	if os.Getenv("STUDIO_DB_TEST") == "" {
		t.Skip("requires the seeded local development database")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, "postgres://btcpp@127.0.0.1:55432/btcpp_dev?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	app := &config.AppContext{DB: pool, Env: &types.EnvConfig{}, Session: scs.New(), Err: log.Default()}
	var confID string
	if err = pool.QueryRow(ctx, `SELECT id FROM conferences WHERE tag='dev26'`).Scan(&confID); err != nil {
		t.Fatal(err)
	}
	d := studioCanvasTemplate(&types.Conf{Tag: "dev26"})
	d.Template = "banner" // Variable data is available to every Graphic template.
	source := d.Assets[d.Nodes[0].Asset]
	d.Nodes[1].Asset = d.Asset(source) // Self-contained fixture, independent of package working directory.
	art, err := studio.InspectArtwork(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	d.Dataset = &studio.Dataset{Source: "event_gifts", Rows: []studio.Recipient{{ID: "fixture", Name: "Fixture", Source: source, Hash: art.Hash}}}
	d.Dataset.Fingerprint = studio.Fingerprint(d.Dataset.Rows)
	raw, _ := json.Marshal(d)
	var id string
	if err = pool.QueryRow(ctx, `INSERT INTO studio_documents(conference_id,name,template,document) VALUES($1,'Canvas API fixture','canvas',$2) RETURNING id`, confID, raw).Scan(&id); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `DELETE FROM studio_documents WHERE id=$1`, id)
	router := mux.NewRouter()
	router.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		if e := auth.LoginPerson(app, r, "00000000-0000-4000-8000-000000000031", auth.MethodEmailLink); e != nil {
			t.Error(e)
		}
	})
	router.HandleFunc("/{conf}/admin/studio/designs/{id}/{action:recipient-data|recipient-preview|export}", func(w http.ResponseWriter, r *http.Request) { StudioDesign(w, r, app) })
	server := httptest.NewServer(SessionMiddleware(app, router))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	res, err := client.Get(server.URL + "/login")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	csvBody, _ := json.Marshal(map[string]any{"revision": 1, "source": "csv", "csv": "ID,Name,Message\nb,Zoe,Hello\na,Adam,Second", "nameColumn": "Name"})
	req, _ := http.NewRequest("POST", server.URL+"/dev26/admin/studio/designs/"+id+"/recipient-data", bytes.NewReader(csvBody))
	req.Header.Set("Origin", server.URL)
	req.Header.Set("Content-Type", "application/json")
	csvResponse, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var csvData studio.Dataset
	if err = json.NewDecoder(csvResponse.Body).Decode(&csvData); err != nil || csvResponse.StatusCode != 200 || len(csvData.Rows) != 2 || csvData.Rows[0].ID != "b" {
		t.Fatalf("CSV preview failed: %d %v", csvResponse.StatusCode, err)
	}
	csvResponse.Body.Close()

	send := func(conf, action, origin string, revision int, doc studio.Document) int {
		body, _ := json.Marshal(map[string]any{"revision": revision, "document": doc, "recipientId": "fixture", "format": "pdf"})
		req, _ := http.NewRequest("POST", server.URL+"/"+conf+"/admin/studio/designs/"+id+"/"+action, bytes.NewReader(body))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		res, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode == 500 {
			t.Fatalf("unexpected server error: %s", b)
		}
		return res.StatusCode
	}
	if status := send("dev26", "recipient-preview", server.URL, 1, d); status != 200 {
		t.Fatal("preview", status)
	}
	if send("berlin26", "recipient-preview", server.URL, 1, d) != 404 {
		t.Fatal("cross-event preview permitted")
	}
	if send("dev26", "recipient-preview", "https://other.example", 1, d) != 403 {
		t.Fatal("cross-origin preview permitted")
	}
	if send("dev26", "recipient-preview", server.URL, 2, d) != 409 {
		t.Fatal("stale preview accepted")
	}
	d.Dataset.Rows[0].Hash = "changed"
	d.Dataset.Fingerprint = studio.Fingerprint(d.Dataset.Rows)
	if send("dev26", "recipient-preview", server.URL, 1, d) != 409 {
		t.Fatal("changed artwork preview accepted without review")
	}
	// Saved fixture differs from live event data: export must stop before opening Chrome.
	if send("dev26", "export", server.URL, 1, d) != 409 {
		t.Fatal("changed source exported")
	}
	var revision int
	pool.QueryRow(ctx, `SELECT revision FROM studio_documents WHERE id=$1`, id).Scan(&revision)
	if revision != 1 {
		t.Fatal("preview/export changed the saved revision")
	}
}
