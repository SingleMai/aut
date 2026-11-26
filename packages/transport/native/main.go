// aut's network-only companion. No daemon credentials or business data are read here.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/ipn"
	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

const tailnetPort = "4318"

type config struct {
	Version    int    `json:"version"`
	Mode       string `json:"mode"`
	Directory  string `json:"directory"`
	LocalPort  int    `json:"localPort,omitempty"`
	PeerNodeID string `json:"peerNodeId,omitempty"`
}

type event struct {
	Type    string `json:"type"`
	URL     string `json:"url,omitempty"`
	NodeID  string `json:"nodeId,omitempty"`
	Port    int    `json:"port,omitempty"`
	Message string `json:"message,omitempty"`
}

func main() {
	log.SetOutput(io.Discard)
	var output sync.Mutex
	emit := func(value event) {
		output.Lock()
		defer output.Unlock()
		_ = json.NewEncoder(os.Stdout).Encode(value)
	}
	if err := run(emit); err != nil {
		emit(event{Type: "error", Message: "Remote transport stopped. Check the network and sign in again if needed."})
		os.Exit(1)
	}
}

func run(emit func(event)) error {
	input := bufio.NewReaderSize(os.Stdin, 32768)
	line, err := input.ReadSlice('\n')
	if err != nil {
		return errors.New("missing bounded startup configuration")
	}
	var cfg config
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing configuration")
	}
	if cfg.Version != 1 || !filepath.IsAbs(cfg.Directory) ||
		(cfg.Mode != "host" && cfg.Mode != "client") ||
		(cfg.Mode == "host" && (cfg.LocalPort < 1 || cfg.LocalPort > 65535 || cfg.PeerNodeID != "")) ||
		(cfg.Mode == "client" && (cfg.PeerNodeID == "" || cfg.LocalPort != 0)) {
		return errors.New("invalid transport configuration")
	}
	if err := os.MkdirAll(cfg.Directory, 0700); err != nil {
		return err
	}
	for _, name := range []string{"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE", "TSNET_FORCE_LOGIN", "TS_CONTROL_URL"} {
		_ = os.Unsetenv(name)
	}
	envknob.SetNoLogsNoSupport()
	netns.SetBindToInterfaceByRoute(logger.Discard, true)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The parent retains stdin as a lifetime pipe after sending the first line.
	go func() { _, _ = io.Copy(io.Discard, input); stop() }()
	node := &tsnet.Server{
		Dir: cfg.Directory, Hostname: "aut-" + cfg.Mode,
		ControlURL: "https://controlplane.tailscale.com",
		Logf:       logger.Discard, UserLogf: logger.Discard,
	}
	defer node.Close()
	return serve(ctx, cfg, node, emit)
}

func serve(ctx context.Context, cfg config, node *tsnet.Server, emit func(event)) error {
	lc, err := node.LocalClient()
	if err != nil {
		return err
	}
	watch, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		return err
	}
	defer watch.Close()
	var loginMu sync.Mutex
	lastLogin := ""
	var ready *event
	login := func(url string) {
		loginMu.Lock()
		defer loginMu.Unlock()
		if url != "" && url != lastLogin {
			lastLogin = url
			emit(event{Type: "login", URL: url})
		}
	}
	go func() {
		for {
			update, err := watch.Next()
			if err != nil {
				return
			}
			if update.BrowseToURL != nil {
				login(*update.BrowseToURL)
			}
			if update.State != nil && *update.State == ipn.Running {
				loginMu.Lock()
				if ready != nil && lastLogin != "" {
					lastLogin = ""
					emit(*ready)
				}
				loginMu.Unlock()
			}
		}
	}()
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return err
	}
	login(status.AuthURL)
	status, err = node.Up(ctx)
	if err != nil {
		return err
	}
	if status.Self == nil || status.Self.ID == "" {
		return errors.New("node identity is unavailable")
	}
	var listener net.Listener
	var dial dialFunc
	var target string
	if cfg.Mode == "host" {
		listener, err = node.Listen("tcp", ":"+tailnetPort)
		dial = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
		target = fmt.Sprintf("127.0.0.1:%d", cfg.LocalPort)
	} else {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
			bounded, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			current, err := lc.Status(bounded)
			if err != nil {
				return nil, err
			}
			for _, peer := range current.Peer {
				if string(peer.ID) == cfg.PeerNodeID && len(peer.TailscaleIPs) > 0 {
					return node.Dial(bounded, network, net.JoinHostPort(peer.TailscaleIPs[0].String(), tailnetPort))
				}
			}
			return nil, errors.New("paired node not found in this tailnet")
		}
	}
	if err != nil {
		return err
	}
	stop := forward(ctx, listener, dial, target)
	defer stop()
	port := 4318
	if cfg.Mode == "client" {
		port = listener.Addr().(*net.TCPAddr).Port
	}
	loginMu.Lock()
	ready = &event{Type: "ready", NodeID: string(status.Self.ID), Port: port}
	lastLogin = ""
	emit(*ready)
	loginMu.Unlock()
	<-ctx.Done()
	return nil
}
