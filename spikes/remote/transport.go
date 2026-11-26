// Isolated transport experiment. This package is not part of the aut runtime.
package main

import (
	"context"
	"io"
	"net"
	"sync"
)

type dialFunc func(context.Context, string, string) (net.Conn, error)

// forward owns the listener and every accepted connection, including upgraded HTTP.
// A client disconnect closes only its own connection, never the remote service.
func forward(parent context.Context, listener net.Listener, dial dialFunc, target string) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	closeListener := context.AfterFunc(ctx, func() { listener.Close() })
	go func() {
		defer close(done)
		var connections sync.WaitGroup
		defer connections.Wait()
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Add(1)
			go func() {
				defer connections.Done()
				defer client.Close()
				closeClient := context.AfterFunc(ctx, func() { client.Close() })
				defer closeClient()
				remote, err := dial(ctx, "tcp", target)
				if err != nil {
					return
				}
				defer remote.Close()
				closeRemote := context.AfterFunc(ctx, func() { remote.Close() })
				defer closeRemote()
				copied := make(chan struct{})
				go func() {
					io.Copy(client, remote)
					client.Close()
					remote.Close()
					close(copied)
				}()
				io.Copy(remote, client)
				remote.Close()
				client.Close()
				<-copied
			}()
		}
	}()
	return func() {
		cancel()
		listener.Close()
		<-done
		closeListener()
	}
}
