package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// App is the Wails backend. Its only job is to run the existing BTCT Bun
// server as a local sidecar process and report readiness to the launcher
// page (loading/index.html), which then navigates the webview to the server.
// All application logic still lives in the Bun server and the React client;
// this Go layer is a launcher and window host, not a rewrite.
type App struct {
	ctx      context.Context
	mu       sync.Mutex
	cmd      *exec.Cmd
	port     int
	ready    bool
	message  string
	startErr string
	dataDir  string
}

func NewApp() *App {
	return &App{message: "Starting local server…"}
}

// State is what the launcher page polls via GetState().
type State struct {
	Ready    bool   `json:"ready"`
	Message  string `json:"message"`
	Error    string `json:"error"`
	LocalURL string `json:"localURL"`
	LANURL   string `json:"lanURL"`
}

// GetState is bound to JS as window.go.main.App.GetState().
func (a *App) GetState() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := State{Ready: a.ready, Message: a.message, Error: a.startErr}
	if a.port != 0 {
		s.LocalURL = fmt.Sprintf("http://127.0.0.1:%d/", a.port)
		if ip := firstLANIP(); ip != "" {
			s.LANURL = fmt.Sprintf("http://%s:%d/", ip, a.port)
		}
	}
	return s
}

func (a *App) setStatus(msg string) {
	a.mu.Lock()
	a.message = msg
	a.mu.Unlock()
}

func (a *App) fail(err string) {
	a.mu.Lock()
	a.startErr = err
	a.mu.Unlock()
}

// startup runs the sidecar launch off the UI thread so the launcher page
// renders immediately.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.launchSidecar()
}

// shutdown (OnShutdown) and beforeClose (OnBeforeClose) stop the sidecar.
// wails dev does not reliably fire OnShutdown, so a real build is where
// process cleanup is verified.
func (a *App) shutdown(ctx context.Context) { a.stopSidecar() }

func (a *App) beforeClose(ctx context.Context) bool {
	a.stopSidecar()
	return false // allow the window to close
}

func (a *App) launchSidecar() {
	dataDir, err := ensureDataDir()
	if err != nil {
		a.fail("data directory: " + err.Error())
		return
	}
	a.dataDir = dataDir

	secret, err := ensureAuthSecret(dataDir)
	if err != nil {
		a.fail("auth secret: " + err.Error())
		return
	}

	serverDir, bunPath, staticDir, err := resolveSidecar()
	if err != nil {
		a.fail(err.Error())
		return
	}

	port := pickPort(8899)
	a.mu.Lock()
	a.port = port
	a.mu.Unlock()

	cmd := exec.Command(bunPath, "index.mjs")
	cmd.Dir = serverDir
	cmd.Env = append(os.Environ(),
		"HOST=0.0.0.0",
		fmt.Sprintf("PORT=%d", port),
		"STATIC_DIR="+staticDir,
		"DB_PATH="+filepath.Join(dataDir, "data.sqlite"),
		"YPERSISTENCE="+filepath.Join(dataDir, "yjs"),
		"ASSETS_DIR="+filepath.Join(dataDir, "assets"),
		"BACKUP_DIR="+filepath.Join(dataDir, "backups"),
		"AUTH_SECRET="+secret,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	a.setStatus("Launching BTCT server…")
	if err := cmd.Start(); err != nil {
		a.fail("could not start bun: " + err.Error())
		return
	}
	a.mu.Lock()
	a.cmd = cmd
	a.mu.Unlock()

	a.setStatus("Waiting for the server…")
	if err := waitHealthy(port, 30*time.Second); err != nil {
		a.fail("server did not become healthy: " + err.Error())
		return
	}
	a.mu.Lock()
	a.ready = true
	a.message = "Ready."
	a.mu.Unlock()
}

func (a *App) stopSidecar() {
	a.mu.Lock()
	cmd := a.cmd
	a.cmd = nil
	a.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	// On Windows, kill the whole tree so any child of bun dies too.
	if runtime.GOOS == "windows" {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", fmt.Sprintf("%d", cmd.Process.Pid)).Run()
	}
	_ = cmd.Process.Kill()
}

// ── helpers ──────────────────────────────────────────────────────────────

// ensureDataDir returns a per-user data directory and creates it.
func ensureDataDir() (string, error) {
	base, err := os.UserConfigDir() // %AppData% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux
	if err != nil || base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".btct")
	}
	dir := filepath.Join(base, "BTCT")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// ensureAuthSecret persists a stable AUTH_SECRET so tokens survive restarts.
func ensureAuthSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, "auth.secret")
	if b, err := os.ReadFile(p); err == nil && len(b) >= 32 {
		return string(b), nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(secret), 0o600); err != nil {
		return "", err
	}
	return secret, nil
}

// resolveSidecar finds the Bun server, the bun binary and the built client
// dist for both the packaged app (a `sidecar/` folder next to the exe) and a
// dev run (the on-disk wails/ project, bun from PATH).
func resolveSidecar() (serverDir, bunPath, staticDir string, err error) {
	exe, _ := os.Executable()
	exeDir := filepath.Dir(exe)

	// Packaged: <exeDir>/sidecar/{server,frontend/dist,bun.exe}
	pkg := filepath.Join(exeDir, "sidecar")
	if fileExists(filepath.Join(pkg, "server", "index.mjs")) {
		bun := filepath.Join(pkg, bunName())
		if !fileExists(bun) {
			bun = "bun" // fall back to PATH if not bundled
		}
		return filepath.Join(pkg, "server"), bun, filepath.Join(pkg, "frontend", "dist"), nil
	}

	// Dev: cwd is the wails/ project root under `wails dev` and `go run .`.
	if wd, e := os.Getwd(); e == nil && fileExists(filepath.Join(wd, "server", "index.mjs")) {
		return filepath.Join(wd, "server"), "bun", filepath.Join(wd, "frontend", "dist"), nil
	}

	// Dev fallback: relative to the source file (works from any cwd).
	if _, file, _, ok := runtime.Caller(0); ok {
		root := filepath.Dir(file)
		if fileExists(filepath.Join(root, "server", "index.mjs")) {
			return filepath.Join(root, "server"), "bun", filepath.Join(root, "frontend", "dist"), nil
		}
	}

	return "", "", "", fmt.Errorf("could not locate the BTCT server (looked for sidecar/ next to the app and ./server in the project)")
}

func bunName() string {
	if runtime.GOOS == "windows" {
		return "bun.exe"
	}
	return "bun"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// pickPort returns `preferred` if free, otherwise an OS-assigned free port.
func pickPort(preferred int) int {
	if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred)); err == nil {
		_ = l.Close()
		return preferred
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return preferred
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitHealthy(port int, timeout time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/healthz", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("timed out after %s", timeout)
}

// firstLANIP returns a non-loopback IPv4 address for the "teammates can join"
// hint, or "" if none is found.
func firstLANIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ip4 := ipnet.IP.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return ""
}
