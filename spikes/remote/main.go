package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"tailscale.com/envknob"
	"tailscale.com/tsnet"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	mode := flag.String("mode", "", "serve or check; serves synthetic data only")
	directory := flag.String("state-dir", "", "dedicated persistent probe state directory")
	peer := flag.String("peer", "", "probe host Tailscale IP; check mode only")
	flag.Parse()
	if *mode != "serve" && *mode != "check" {
		return errors.New("mode must be serve or check")
	}
	secret := os.Getenv("AUT_REMOTE_PROBE_TOKEN")
	if len(secret) < 32 || *directory == "" {
		return errors.New("a dedicated state-dir and AUT_REMOTE_PROBE_TOKEN of at least 32 characters are required")
	}
	userDirectory, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	absolute, err := probeDirectory(*directory, userDirectory)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(absolute, 0700); err != nil {
		return err
	}
	if *mode == "check" {
		ip, err := netip.ParseAddr(*peer)
		if err != nil || !(netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)) {
			return errors.New("peer must be an explicit Tailscale IP")
		}
	}
	for _, name := range identityEnvironment {
		if os.Getenv(name) != "" {
			return fmt.Errorf("unset %s for the isolated interactive-login probe", name)
		}
	}
	envknob.SetNoLogsNoSupport()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	node := &tsnet.Server{
		Dir: absolute, Hostname: "aut-probe-" + *mode,
		ControlURL: "https://controlplane.tailscale.com",
		Logf:       func(string, ...any) {},
		UserLogf:   log.Printf,
	}
	defer node.Close()
	startup, stopStartup := context.WithTimeout(ctx, 3*time.Minute)
	status, err := node.Up(startup)
	stopStartup()
	if err != nil {
		return fmt.Errorf("probe node could not connect: %w", err)
	}
	if *mode == "serve" {
		backend := httptest.NewServer(newFixture(ctx, secret))
		defer backend.Close()
		listener, err := node.Listen("tcp", ":8080")
		if err != nil {
			return err
		}
		stop := forward(ctx, listener, (&net.Dialer{Timeout: 10 * time.Second}).DialContext, backend.Listener.Addr().String())
		defer stop()
		fmt.Printf("Synthetic probe is ready on %s:8080. No aut daemon is exposed.\n", status.TailscaleIPs[0])
		<-ctx.Done()
		return nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	stop := forward(ctx, listener, node.Dial, net.JoinHostPort(*peer, "8080"))
	defer stop()
	client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	base := "http://" + listener.Addr().String()
	for _, check := range checks {
		if err := check.run(ctx, client, base, secret); err != nil {
			return fmt.Errorf("%s failed: %w", check.name, err)
		}
		fmt.Println("PASS " + check.name)
	}
	return nil
}

type check struct {
	name string
	run  func(context.Context, *http.Client, string, string) error
}

var checks = []check{
	{"HTTP", func(ctx context.Context, client *http.Client, base, secret string) error {
		got, err := request(ctx, client, base+"/probe/health", secret, "")
		if err == nil && string(got) != "aut-remote-probe" {
			return errors.New("unexpected health response")
		}
		return err
	}},
	{"FileRoundTrip", func(ctx context.Context, client *http.Client, base, secret string) error {
		payload := strings.Repeat("aut-probe-\x00\xff\n", 50000)
		got, err := request(ctx, client, base+"/probe/file", secret, payload)
		if err != nil {
			return err
		}
		if sha256.Sum256([]byte(payload)) != sha256.Sum256(got) {
			return errors.New("file digest mismatch")
		}
		return nil
	}},
	{"Preview", func(ctx context.Context, client *http.Client, base, secret string) error {
		got, err := request(ctx, client, base+"/probe/preview", secret, "")
		if err == nil && !strings.Contains(string(got), "<title>aut remote probe</title>") {
			return errors.New("unexpected preview")
		}
		return err
	}},
	{"WebSocket", func(ctx context.Context, client *http.Client, base, secret string) error {
		conn, _, err := websocket.Dial(ctx, strings.Replace(base, "http:", "ws:", 1)+"/probe/events", &websocket.DialOptions{
			HTTPClient: client, HTTPHeader: http.Header{"Authorization": {"Bearer " + secret}},
		})
		if err != nil {
			return err
		}
		defer conn.CloseNow()
		payload := []byte("synthetic-event:" + hex.EncodeToString([]byte{1, 2, 3}))
		if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
			return err
		}
		_, got, err := conn.Read(ctx)
		if err == nil && string(got) != string(payload) {
			return errors.New("WebSocket payload mismatch")
		}
		return err
	}},
}

func request(ctx context.Context, client *http.Client, address, secret, body string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, address, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected HTTP status %d", response.StatusCode)
	}
	return io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
}
