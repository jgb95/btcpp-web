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

// Only creates and deletes its own document; existing event drafts are untouched.
func TestStudioRevisionAndScope(t *testing.T) {
	if os.Getenv("STUDIO_DB_TEST") == "" {
		t.Skip("requires the seeded local database on 55432")
	}
	ctx := context.Background()
	pool, e := pgxpool.New(ctx, "postgres://btcpp@127.0.0.1:55432/btcpp_dev?sslmode=disable")
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	app := &config.AppContext{DB: pool, Env: &types.EnvConfig{}, Session: scs.New(), Err: log.Default()}
	var confID string
	if e = pool.QueryRow(ctx, `SELECT id FROM conferences WHERE tag='dev26'`).Scan(&confID); e != nil {
		t.Fatal(e)
	}
	d := studio.New("overlay")
	n := studio.Item("caption", "text", "Caption")
	n.Text = "Fixture"
	n.X = 100
	n.Y = 100
	d.Nodes = append(d.Nodes, n)
	raw, _ := json.Marshal(d)
	var id string
	if e = pool.QueryRow(ctx, `INSERT INTO studio_documents(conference_id,name,template,document) VALUES($1,'Studio API fixture','overlay',$2) RETURNING id`, confID, raw).Scan(&id); e != nil {
		t.Fatal(e)
	}
	defer pool.Exec(ctx, `DELETE FROM studio_documents WHERE id=$1`, id)
	router := mux.NewRouter()
	router.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		if e := auth.LoginPerson(app, r, "00000000-0000-4000-8000-000000000031", auth.MethodEmailLink); e != nil {
			t.Error(e)
		}
	})
	router.HandleFunc("/{conf}/admin/studio/designs/{id}/{action:prepare-layout|delete|restore}", func(w http.ResponseWriter, r *http.Request) { StudioDesign(w, r, app) })
	router.HandleFunc("/{conf}/admin/studio/designs/{id}", func(w http.ResponseWriter, r *http.Request) { StudioDesign(w, r, app) })
	server := httptest.NewServer(SessionMiddleware(app, router))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	response, e := client.Get(server.URL + "/login")
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	send := func(conf string, revision int, origin string) int {
		payload, _ := json.Marshal(map[string]any{"revision": revision, "name": "Saved fixture", "document": d})
		req, _ := http.NewRequest("POST", server.URL+"/"+conf+"/admin/studio/designs/"+id, bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode == 500 {
			t.Fatalf("server failure: %s", body)
		}
		return response.StatusCode
	}
	if status := send("dev26", 1, server.URL); status != 200 {
		t.Fatalf("save: %d", status)
	}
	if status := send("dev26", 1, server.URL); status != 409 {
		t.Fatalf("stale save: %d", status)
	}
	if status := send("berlin26", 2, server.URL); status != 404 {
		t.Fatalf("cross-event read: %d", status)
	}
	if status := send("dev26", 2, "https://other.example"); status != 403 {
		t.Fatalf("cross-origin write: %d", status)
	}
	prepare := func(conf string, revision int, doc studio.Document) int {
		payload, _ := json.Marshal(map[string]any{"revision": revision, "document": doc})
		req, _ := http.NewRequest("POST", server.URL+"/"+conf+"/admin/studio/designs/"+id+"/prepare-layout", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode == 200 {
			var data struct{ Assets map[string]string }
			if err = json.NewDecoder(response.Body).Decode(&data); err != nil {
				t.Fatal(err)
			}
			if data.Assets == nil {
				t.Fatal("missing prepared assets")
			}
		}
		return response.StatusCode
	}
	if status := prepare("dev26", 2, d); status != 200 {
		t.Fatalf("prepare: %d", status)
	}
	if status := prepare("dev26", 1, d); status != 409 {
		t.Fatalf("stale prepare: %d", status)
	}
	if status := prepare("berlin26", 2, d); status != 404 {
		t.Fatalf("cross-event prepare: %d", status)
	}
	invalid := d
	invalid.ArtworkBounds = map[string]studio.ArtworkBounds{"missing": {X: 0, Y: 0, Width: 1, Height: 1}}
	if status := prepare("dev26", 2, invalid); status != 400 {
		t.Fatalf("invalid metadata: %d", status)
	}
	var rev int
	if e = pool.QueryRow(ctx, `SELECT revision FROM studio_documents WHERE id=$1`, id).Scan(&rev); e != nil || rev != 2 {
		t.Fatalf("revision %d: %v", rev, e)
	}
	action := func(conf, verb string, revision int) int {
		body, _ := json.Marshal(map[string]any{"revision": revision})
		req, _ := http.NewRequest("POST", server.URL+"/"+conf+"/admin/studio/designs/"+id+"/"+verb, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL)
		res, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if action("berlin26", "delete", 2) != 404 {
		t.Fatal("cross-event deletion permitted")
	}
	if action("dev26", "delete", 1) != 409 {
		t.Fatal("stale deletion permitted")
	}
	if action("dev26", "delete", 2) != 200 {
		t.Fatal("delete failed")
	}
	if status := send("dev26", 3, server.URL); status != 404 {
		t.Fatal("deleted design can be saved", status)
	}
	if action("dev26", "restore", 2) != 409 {
		t.Fatal("stale restore permitted")
	}
	if action("dev26", "restore", 3) != 200 {
		t.Fatal("restore failed")
	}
	if status := send("dev26", 4, server.URL); status != 200 {
		t.Fatal("restored design not writable", status)
	}

}
