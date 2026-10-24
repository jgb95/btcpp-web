package handlers

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"btcpp-web/internal/config"

	"github.com/alexedwards/scs/v2"
)

func TestStudioDownloadKeepsSessionAndResponseDeadline(t *testing.T) {
	session := scs.New()
	app := &config.AppContext{Session: session}
	server := httptest.NewServer(SessionMiddleware(app, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login-test" {
			session.Put(r.Context(), "example", "signed-in")
			return
		}
		if session.GetString(r.Context(), "example") != "signed-in" {
			t.Error("export lost session")
		}
		recorder := &statusRecorder{ResponseWriter: w}
		if err := http.NewResponseController(recorder).SetWriteDeadline(time.Now().Add(time.Minute)); err != nil {
			t.Errorf("export cannot extend deadline: %v", err)
		}
		io.WriteString(recorder, "download")
	})))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	response, err := client.Get(server.URL + "/login-test")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	response, err = client.Post(server.URL+"/event/admin/studio/designs/00000000-0000-4000-8000-000000000001/export", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || string(data) != "download" {
		t.Fatalf("download: %q %v", data, err)
	}
}
