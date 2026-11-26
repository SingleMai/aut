package main

import (
	"context"
	"crypto/subtle"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// fixture contains synthetic data only. Its worker belongs to the host context.
type fixture struct {
	secret string
	ticks  atomic.Int64
}

func newFixture(ctx context.Context, secret string) *fixture {
	f := &fixture{secret: secret}
	go func() {
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				f.ticks.Add(1)
			}
		}
	}()
	return f
}

func (f *fixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+f.secret)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.URL.Path {
	case "/probe/health":
		io.WriteString(w, "aut-remote-probe")
	case "/probe/file":
		w.Header().Set("Content-Type", "application/octet-stream")
		payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		w.Write(payload)
	case "/probe/preview":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, "<!doctype html><title>aut remote probe</title><p>Synthetic remote preview</p>")
	case "/probe/events":
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		conn.SetReadLimit(1 << 20)
		for {
			kind, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if err := conn.Write(r.Context(), kind, data); err != nil {
				return
			}
		}
	default:
		http.NotFound(w, r)
	}
}
