package studio

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

//go:embed scene.js
var SceneJS string

// ExportOptions chooses an output without changing the saved production or layout.
type ExportOptions struct {
	Format string `json:"format"`
}

func (o ExportOptions) Validate(d Document) error {
	if o.Format == "" {
		o.Format = map[string]string{"graphic": "png", "video": "mp4"}[d.Type()]
	}
	if o.Format != "" && o.Format != "pdf" && o.Format != "png" && o.Format != "mp4" {
		return fmt.Errorf("choose PDF, PNG, or MP4")
	}
	if o.Format == "mp4" && d.Type() != "video" {
		return fmt.Errorf("MP4 is available for video designs")
	}
	if d.Type() == "video" && o.Format != "mp4" {
		return fmt.Errorf("video designs export as MP4; switch to Graphic for PNG or PDF")
	}
	return nil
}
func Render(parent context.Context, d Document) (path, mime, ext string, resultErr error) {
	return RenderWithOptions(parent, d, ExportOptions{})
}
func RenderWithOptions(parent context.Context, d Document, options ExportOptions) (path, mime, ext string, resultErr error) {
	if options.Format == "" {
		options.Format = map[string]string{"graphic": "png", "video": "mp4"}[d.Type()]
	}
	if err := options.Validate(d); err != nil {
		return "", "", "", err
	}

	if err := d.Validate(); err != nil {
		return "", "", "", err
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()
	if err := Freeze(ctx, &d); err != nil {
		return "", "", "", err
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
		return "", "", "", fmt.Errorf("bundled font: %w", fontErr)
	}
	raw, _ := json.Marshal(d)
	fontJSON, _ := json.Marshal(fonts)
	width, height := d.PixelSize()
	paperWidth, paperHeight := width*25.4/96, height*25.4/96
	css := fmt.Sprintf("html,body{margin:0;padding:0;background:transparent}#scene>svg{display:block;width:%gpx;height:%gpx} @page{size:%gmm %gmm;margin:0} @media print{#scene>svg{width:%gmm;height:%gmm}}", width, height, paperWidth, paperHeight, paperWidth, paperHeight)
	html := `<!doctype html><meta charset="utf-8"><style>` + css + `</style><div id="scene"></div><script>` + SceneJS + `</script><script>window.scene=StudioScene.mount(document.getElementById('scene'),` + string(raw) + `,` + string(fontJSON) + `);window.ready=scene.ready().then(errors=>{if(errors.length)throw Error(errors.join(', '));return true});</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:")
		fmt.Fprint(w, html)
	}))
	defer server.Close()
	opts := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	opts = append(opts, chromedp.DisableGPU)
	if chrome := os.Getenv("CHROME_PATH"); chrome != "" {
		opts = append(opts, chromedp.ExecPath(chrome))
	}
	alloc, stop := chromedp.NewExecAllocator(ctx, opts...)
	defer stop()
	browser, closeBrowser := chromedp.NewContext(alloc)
	defer closeBrowser()
	if err := chromedp.Do(browser,
		chromedp.EmulateViewport(int64(math.Ceil(width)), int64(math.Ceil(height))),
		chromedp.Func(func(c context.Context, target *chromedp.Target) error {
			// The generated RGBA binding omits zero alpha, which Chrome interprets as opaque.
			// Send alpha explicitly so transparent PNGs retain their background.
			command := cdp.Command[map[string]any, cdp.Empty]{Method: emulation.CommandSetDefaultBackgroundColorOverride}
			_, err := cdp.Call(c, target, command, map[string]any{"color": map[string]any{"r": 0, "g": 0, "b": 0, "a": 0}})
			return err
		}),
		chromedp.Navigate(server.URL),
	); err != nil {
		return "", "", "", err
	}
	ready, err := chromedp.Run(browser, chromedp.Evaluate[bool]("window.ready", chromedp.EvalAwaitPromise))
	if err != nil {
		return "", "", "", err
	}

	if !ready {
		return "", "", "", fmt.Errorf("artwork did not become ready")
	}
	ext = "." + options.Format
	mime = map[string]string{"pdf": "application/pdf", "png": "image/png", "mp4": "video/mp4"}[options.Format]

	f, err := os.CreateTemp("", "studio-*"+ext)
	if err != nil {
		return "", "", "", err
	}
	path = f.Name()
	f.Close()
	defer func() {
		if resultErr != nil {
			os.Remove(path)
		}
	}()
	if options.Format != "mp4" {
		var data []byte
		if options.Format == "pdf" {
			yes, zero := true, 0.0
			result, e := chromedp.Call(browser, page.PrintToPDF, page.PrintToPDFParams{
				PrintBackground: &yes, PreferCSSPageSize: &yes,
				PaperWidth: paperWidth / 25.4, PaperHeight: paperHeight / 25.4,
				MarginTop: &zero, MarginBottom: &zero, MarginLeft: &zero, MarginRight: &zero,
			})
			data, err = result.Data, e
		} else {
			data, err = chromedp.Run(browser, chromedp.CaptureScreenshot())
		}
		if err != nil {
			return path, mime, ext, err
		}
		return path, mime, ext, os.WriteFile(path, data, 0600)
	}
	encoder := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", "30", "-vcodec", "png", "-i", "pipe:0", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0", "-t", strconv.FormatFloat(d.Duration, 'f', -1, 64), "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", "6800k", "-minrate", "6800k", "-maxrate", "6800k", "-bufsize", "13600k", "-r", "30", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", path)
	var stderr bytes.Buffer
	encoder.Stderr = &stderr
	pipe, err := encoder.StdinPipe()
	if err != nil {
		return path, mime, ext, err
	}
	if err = encoder.Start(); err != nil {
		return path, mime, ext, err
	}
	defer func() {
		pipe.Close()
		if encoder.ProcessState == nil {
			encoder.Process.Kill()
			encoder.Wait()
		}
	}()
	for i := 0; i < int(d.Duration*30+.5); i++ {
		if err = chromedp.Do(browser, chromedp.Evaluate[chromedp.Void](fmt.Sprintf("scene.render(%g)", float64(i)/30))); err != nil {
			return path, mime, ext, err
		}
		png, e := chromedp.Run(browser, chromedp.CaptureScreenshot())
		if e != nil {
			return path, mime, ext, e
		}
		if _, err = pipe.Write(png); err != nil {
			return path, mime, ext, err
		}
	}
	pipe.Close()
	if err = encoder.Wait(); err != nil {
		return path, mime, ext, fmt.Errorf("video encoding: %s", stderr.String())
	}
	if err = VerifyVideo(ctx, path, d.Duration, int(width), int(height)); err != nil {
		return path, mime, ext, err
	}
	return path, mime, ext, nil
}
func VerifyVideo(ctx context.Context, path string, seconds float64, dimensions ...int) error {
	width, height := 1920, 1080
	if len(dimensions) == 2 {
		width, height = dimensions[0], dimensions[1]
	}
	data, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path).Output()
	if err != nil {
		return err
	}
	var p struct {
		Streams []struct {
			CodecType     string `json:"codec_type"`
			CodecName     string `json:"codec_name"`
			Width, Height int
			PixFmt        string `json:"pix_fmt"`
			Rate          string `json:"r_frame_rate"`
			SampleRate    string `json:"sample_rate"`
			Channels      int
		}
		Format struct{ Duration string }
	}
	if err = json.Unmarshal(data, &p); err != nil {
		return err
	}
	video, audio := false, false
	for _, s := range p.Streams {
		if s.CodecType == "video" {
			video = s.CodecName == "h264" && s.Width == width && s.Height == height && s.PixFmt == "yuv420p" && s.Rate == "30/1"
		}
		if s.CodecType == "audio" {
			audio = s.CodecName == "aac" && s.SampleRate == "48000" && s.Channels == 2
		}
	}
	duration, _ := strconv.ParseFloat(p.Format.Duration, 64)
	if !video || !audio || duration < seconds-.04 || duration > seconds+.1 {
		return fmt.Errorf("video output verification failed")
	}
	return nil
}
