package studio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// A renderer reuses one Chrome session for a document or a complete canvas batch.
type renderer struct {
	browser     context.Context
	html        atomic.Value
	server      *httptest.Server
	stop, close context.CancelFunc
}

func newRenderer(ctx context.Context) *renderer {
	r := &renderer{}
	r.html.Store("")
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:")
		fmt.Fprint(w, r.html.Load().(string))
	}))
	opts := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	opts = append(opts, chromedp.DisableGPU)
	if chrome := os.Getenv("CHROME_PATH"); chrome != "" {
		opts = append(opts, chromedp.ExecPath(chrome))
	}
	alloc, stop := chromedp.NewExecAllocator(ctx, opts...)
	r.stop = stop
	r.browser, r.close = chromedp.NewContext(alloc)
	return r
}
func (r *renderer) Close() { r.close(); r.stop(); r.server.Close() }
func (r *renderer) loadHTML(html string, w, h float64) error {
	r.html.Store(html)
	return chromedp.Do(r.browser, chromedp.EmulateViewport(int64(math.Ceil(w)), int64(math.Ceil(h))), chromedp.Func(func(c context.Context, target *chromedp.Target) error {
		// Send explicit zero alpha; the generated RGBA binding omits it.
		command := cdp.Command[map[string]any, cdp.Empty]{Method: emulation.CommandSetDefaultBackgroundColorOverride}
		_, err := cdp.Call(c, target, command, map[string]any{"color": map[string]any{"r": 0, "g": 0, "b": 0, "a": 0}})
		return err
	}), chromedp.Navigate(r.server.URL))
}
func (r *renderer) load(d Document) error {
	if err := Freeze(r.browser, &d); err != nil {
		return err
	}
	fonts := map[string]string{}
	var fontErr error
	Walk(d.Nodes, func(n *Node) {
		if n.Kind != "text" || fonts[n.Font] != "" {
			return
		}
		b, e := os.ReadFile("static/fonts/" + Fonts[n.Font])
		if e != nil {
			fontErr = e
			return
		}
		fonts[n.Font] = "data:font/otf;base64," + base64.StdEncoding.EncodeToString(b)
	})
	if fontErr != nil {
		return fmt.Errorf("bundled font: %w", fontErr)
	}
	raw, _ := json.Marshal(d)
	fontJSON, _ := json.Marshal(fonts)
	width, height := d.PixelSize()
	pw, ph := width*25.4/96, height*25.4/96
	css := fmt.Sprintf("html,body{margin:0;padding:0;background:transparent}#scene>svg{display:block;width:%gpx;height:%gpx} @page{size:%gmm %gmm;margin:0} @media print{#scene>svg{width:%gmm;height:%gmm}}", width, height, pw, ph, pw, ph)
	html := `<!doctype html><meta charset="utf-8"><style>` + css + `</style><div id="scene"></div><script>` + SceneJS + `</script><script>window.scene=StudioScene.mount(document.getElementById('scene'),` + string(raw) + `,` + string(fontJSON) + `);window.ready=scene.ready().then(errors=>{if(errors.length)throw Error(errors.join(', '));return true});</script>`
	if err := r.loadHTML(html, width, height); err != nil {
		return err
	}
	ready, err := chromedp.Run(r.browser, chromedp.Evaluate[bool]("window.ready", chromedp.EvalAwaitPromise))
	if err != nil {
		return err
	}
	if !ready {
		return fmt.Errorf("artwork did not become ready")
	}
	return nil
}
func (r *renderer) pdf() ([]byte, error) {
	yes, zero := true, 0.
	result, err := chromedp.Call(r.browser, page.PrintToPDF, page.PrintToPDFParams{PrintBackground: &yes, PreferCSSPageSize: &yes, MarginTop: &zero, MarginBottom: &zero, MarginLeft: &zero, MarginRight: &zero})
	return result.Data, err
}

// thumbnail captures the same loaded scene as the PDF without changing artwork or layout.
func (r *renderer) thumbnail(d Document) ([]byte, error) {
	width, height := d.PixelSize()
	result, err := chromedp.Call(r.browser, page.CaptureScreenshot, page.CaptureScreenshotParams{Format: page.CaptureScreenshotFormatPng, Clip: &page.Viewport{Width: width, Height: height, Scale: min(1, 480/max(width, height))}})
	return result.Data, err
}
