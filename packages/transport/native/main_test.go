package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
	"tailscale.com/envknob"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// Real production forwarding against upstream local control/DERP fixtures.
// Hosted login, NAT and two physical Macs are separate acceptance checks.
func TestPairedTransport(t *testing.T) {
	envknob.SetNoLogsNoSupport()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	control := &testcontrol.Server{DERPMap: integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"), DNSConfig: &tailcfg.DNSConfig{Proxied: true}, MagicDNSDomain: "aut-transport.test", Logf: logger.Discard}
	control.HTTPTestServer = httptest.NewServer(control)
	defer control.HTTPTestServer.Close()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-only" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/events" {
			ws, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer ws.CloseNow()
			for {
				kind, data, err := ws.Read(r.Context())
				if err != nil {
					return
				}
				if ws.Write(r.Context(), kind, data) != nil {
					return
				}
			}
		}
		io.WriteString(w, "fixture bytes\x00\xff")
	}))
	defer backend.Close()
	_, portText, _ := net.SplitHostPort(backend.Listener.Addr().String())
	backendPort, _ := strconv.Atoi(portText)
	start := func(cfg config) (event, func()) {
		t.Helper()
		childCtx, stop := context.WithCancel(ctx)
		node := &tsnet.Server{Dir: cfg.Directory, Hostname: "aut-" + cfg.Mode, ControlURL: control.HTTPTestServer.URL, Logf: logger.Discard, UserLogf: logger.Discard}
		ready := make(chan event, 8)
		done := make(chan error, 1)
		go func() { done <- serve(childCtx, cfg, node, func(value event) { ready <- value }) }()
		closed := false
		close := func() {
			if closed {
				return
			}
			closed = true
			stop()
			<-done
			node.Close()
		}
		t.Cleanup(close)
		for {
			select {
			case event := <-ready:
				if event.Type == "ready" {
					return event, close
				}
			case err := <-done:
				closed = true
				stop()
				node.Close()
				t.Fatalf("companion exited before ready: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	host, _ := start(config{Version: 1, Mode: "host", Directory: t.TempDir(), LocalPort: backendPort})
	state := t.TempDir()
	client, disconnect := start(config{Version: 1, Mode: "client", Directory: state, PeerNodeID: host.NodeID})
	httpClient := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer httpClient.CloseIdleConnections()
	read := func(port int) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/file", port), nil)
		req.Header.Set("Authorization", "Bearer fixture-only")
		resp, err := httpClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil || string(data) != "fixture bytes\x00\xff" {
			t.Fatalf("file roundtrip failed: %v", err)
		}
	}
	read(client.Port)
	ws, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/events", client.Port), &websocket.DialOptions{HTTPClient: httpClient, HTTPHeader: http.Header{"Authorization": []string{"Bearer fixture-only"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = ws.Write(ctx, websocket.MessageText, []byte("live")); err != nil {
		t.Fatal(err)
	}
	_, data, err := ws.Read(ctx)
	if err != nil || string(data) != "live" {
		t.Fatalf("websocket: %v", err)
	}
	disconnect()
	bounded, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	if _, _, err = ws.Read(bounded); err == nil {
		t.Fatal("client shutdown retained upgraded connection")
	}
	ws.CloseNow()
	// A new client process retains its identity; the original host keeps serving.
	again, closeAgain := start(config{Version: 1, Mode: "client", Directory: state, PeerNodeID: host.NodeID})
	if again.NodeID != client.NodeID {
		t.Fatal("client identity changed")
	}
	read(again.Port)
	closeAgain()
	wrong, _ := start(config{Version: 1, Mode: "client", Directory: t.TempDir(), PeerNodeID: "wrong-peer"})
	if response, err := httpClient.Get(fmt.Sprintf("http://127.0.0.1:%d/file", wrong.Port)); err == nil {
		response.Body.Close()
		t.Fatal("unknown peer was forwarded")
	}
}
