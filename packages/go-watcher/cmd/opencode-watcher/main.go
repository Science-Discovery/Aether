package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"

	"github.com/opencode-ai/go-watcher/internal/protocol"
	"github.com/opencode-ai/go-watcher/internal/watch"
)

func main() {
	if err := run(); err != nil {
		_ = protocol.Encode(os.Stdout, protocol.Error{
			V:     protocol.Version,
			Type:  "error",
			Stage: "start",
			Fatal: true,
			Error: err.Error(),
		})
		os.Exit(1)
	}
}

func run() error {
	msg, err := protocol.Decode(os.Stdin)
	if err != nil {
		_ = protocol.Encode(os.Stdout, protocol.Error{
			V:     protocol.Version,
			Type:  "error",
			Stage: "decode",
			Fatal: true,
			Error: err.Error(),
		})
		return err
	}

	svc, err := watch.New(msg.Root, msg.Ignore, msg.Filter, func(msg any) error {
		return protocol.Encode(os.Stdout, msg)
	})
	if err != nil {
		return err
	}
	defer svc.Close()

	stats, err := svc.Start()
	if err != nil {
		return err
	}
	if err := protocol.Encode(os.Stdout, protocol.Ready{
		V:       protocol.Version,
		Type:    "ready",
		Watched: stats.Watched,
		Ignored: stats.Ignored,
	}); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err = svc.Run(ctx)
	if err == nil || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
