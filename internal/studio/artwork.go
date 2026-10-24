package studio

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Freeze embeds used originals once per asset so saved designs and exports are stable.
// Chrome gets only data URLs and cannot make external requests.
func Freeze(ctx context.Context, d *Document) error {
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !validSource(req.URL.String()) {
			return fmt.Errorf("unsupported artwork redirect")
		}
		return nil
	}}
	cache := map[string]string{}
	asset := func(source string) (string, error) {
		if source == "" || strings.HasPrefix(source, "data:") {
			return source, nil
		}
		if cached, ok := cache[source]; ok {
			return cached, nil
		}
		if !validSource(source) {
			return "", fmt.Errorf("unsupported artwork source")
		}
		var reader io.ReadCloser
		var mediaType string
		if strings.HasPrefix(source, "/static/") {
			file, err := os.Open(strings.TrimPrefix(source, "/"))
			if err != nil {
				return "", err
			}
			reader = file
			mediaType = mime.TypeByExtension(filepath.Ext(source))
		} else {
			req, err := http.NewRequestWithContext(ctx, "GET", source, nil)
			if err != nil {
				return "", err
			}
			response, err := client.Do(req)
			if err != nil {
				return "", err
			}
			if response.StatusCode != 200 {
				response.Body.Close()
				return "", fmt.Errorf("artwork returned HTTP %d", response.StatusCode)
			}
			reader = response.Body
			mediaType = response.Header.Get("Content-Type")
		}
		defer reader.Close()
		data, err := io.ReadAll(io.LimitReader(reader, (10<<20)+1))
		if err != nil {
			return "", err
		}
		if len(data) > 10<<20 {
			return "", fmt.Errorf("artwork exceeds 10 MB")
		}
		mediaType, _, _ = mime.ParseMediaType(mediaType)
		if mediaType == "" || mediaType == "application/octet-stream" {
			mediaType = http.DetectContentType(data)
		}
		result := "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data)
		if !validSource(result) {
			return "", fmt.Errorf("unsupported artwork type %q", mediaType)
		}
		cache[source] = result
		return result, nil
	}

	names := map[string]string{}
	if d.Background.Asset != "" {
		names[d.Background.Asset] = "Background"
	}
	Walk(d.Nodes, func(n *Node) {
		if n.Kind == "image" {
			names[n.Asset] = n.Name
		}
	})
	assets := map[string]string{}
	for id, name := range names {
		source := d.Assets[id]
		if source == "" {
			return fmt.Errorf("replace missing artwork for %s", name)
		}
		original, err := asset(source)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		assets[id] = original
	}
	for id := range d.ArtworkBounds {
		if _, ok := assets[id]; !ok {
			delete(d.ArtworkBounds, id)
		}
	}
	d.Assets = assets
	return nil
}

func validSource(source string) bool {
	if source == "" {
		return true
	}
	if len(source) > 14<<20 {
		return false
	}
	if strings.HasPrefix(source, "/static/") && !strings.ContainsAny(source, "\\?#%") && !strings.Contains(source, "..") {
		return true
	}
	for _, mime := range []string{"image/svg+xml", "image/png", "image/jpeg", "image/avif", "image/webp"} {
		if data, ok := strings.CutPrefix(source, "data:"+mime+";base64,"); ok {
			decoded, err := base64.StdEncoding.DecodeString(data)
			return err == nil && len(decoded) > 0 && len(decoded) <= 10<<20
		}
	}
	u, err := url.Parse(source)
	return err == nil && u.Scheme == "https" && u.User == nil && u.Port() == "" && (u.Host == "btcpp.dev" || u.Host == "btcpp.nyc3.digitaloceanspaces.com")
}
