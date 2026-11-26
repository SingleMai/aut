package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// The control plane and DERP are upstream test fixtures. Peer transport is real tsnet.
// This does not exercise Tailscale's hosted control plane, internet NAT or two Macs.
func TestLocalTransport(t *testing.T) {
	for _, name := range identityEnvironment {
		t.Setenv(name, "")
	}
	envknob.SetNoLogsNoSupport()
	interfacesBefore, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	control := &testcontrol.Server{
		DERPMap:        integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"),
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "aut-probe.test", Logf: logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	newNode := func(name, directory string) *tsnet.Server {
		node := &tsnet.Server{
			Dir: directory, Hostname: name, ControlURL: control.HTTPTestServer.URL,
			Logf: logger.Discard, UserLogf: logger.Discard,
		}
		if _, err := node.Up(ctx); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { node.Close() })
		return node
	}
	host := newNode("probe-host", t.TempDir())
	status, err := host.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	secret := "isolated-synthetic-token-not-a-user-credential"
	worker := newFixture(ctx, secret)
	backend := httptest.NewServer(worker)
	t.Cleanup(backend.Close)
	remoteListener, err := host.Listen("tcp", ":8080")
	if err != nil {
		t.Fatal(err)
	}
	stopHost := forward(ctx, remoteListener, (&net.Dialer{Timeout: 5 * time.Second}).DialContext, backend.Listener.Addr().String())
	t.Cleanup(stopHost)
	target := net.JoinHostPort(status.TailscaleIPs[0].String(), "8080")
	clientState := t.TempDir()
	clientNode := newNode("probe-client", clientState)
	clientStatus, err := clientNode.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("NoSystemInterfaceAdded", func(t *testing.T) {
		after, err := net.Interfaces()
		if err != nil {
			t.Fatal(err)
		}
		if len(after) != len(interfacesBefore) {
			t.Fatal("system network interface count changed")
		}
		for i, current := range after {
			if current.Name != interfacesBefore[i].Name || current.Index != interfacesBefore[i].Index {
				t.Fatal("system network interfaces changed")
			}
		}
	})
	connect := func(node *tsnet.Server) (*http.Client, string, func()) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		stop := forward(ctx, listener, node.Dial, target)
		client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}
		close := func() { client.CloseIdleConnections(); stop() }
		t.Cleanup(close)
		return client, "http://" + listener.Addr().String(), close
	}
	client, base, disconnect := connect(clientNode)
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.run(ctx, client, base, secret); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("AuthenticationRequired", func(t *testing.T) {
		response, err := client.Get(base + "/probe/health")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated request returned %d", response.StatusCode)
		}
	})
	t.Run("HostSurvivesClientDisconnect", func(t *testing.T) {
		disconnect()
		if err := clientNode.Close(); err != nil {
			t.Fatal(err)
		}
		before := worker.ticks.Load()
		timer := time.NewTimer(100 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		if worker.ticks.Load() <= before {
			t.Fatal("synthetic host worker stopped with the client")
		}
	})
	t.Run("ReconnectWithRetainedIdentity", func(t *testing.T) {
		reconnected := newNode("probe-client", clientState)
		reconnectedStatus, err := reconnected.Up(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if reconnectedStatus.Self.PublicKey != clientStatus.Self.PublicKey {
			t.Fatal("client identity changed after restart")
		}
		client, base, _ := connect(reconnected)
		for _, check := range checks {
			if err := check.run(ctx, client, base, secret); err != nil {
				t.Fatalf("%s after reconnect: %v", check.name, err)
			}
		}
	})
}
