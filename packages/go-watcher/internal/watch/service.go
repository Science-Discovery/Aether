package watch

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/fsnotify/fsnotify"
	"github.com/opencode-ai/go-watcher/internal/protocol"
)

type Service struct {
	root   string
	match  *Matcher
	filter *Matcher
	emit   func(any) error
	w      *fsnotify.Watcher
	dirs   map[string]int
}

func New(root string, ignore []string, filter []string, emit func(any) error) (*Service, error) {
	match, err := Compile(root, ignore)
	if err != nil {
		return nil, err
	}
	name, err := CompileFilter(root, filter)
	if err != nil {
		return nil, err
	}
	return &Service{
		root:   filepath.Clean(root),
		match:  match,
		filter: name,
		emit:   emit,
		dirs:   map[string]int{},
	}, nil
}

func (svc *Service) Start() (Stats, error) {
	if !filepath.IsAbs(svc.root) {
		return Stats{}, errors.New("root must be absolute")
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return Stats{}, err
	}
	svc.w = w

	stats, err := Scan(svc.root, svc.match, svc.add)
	if err != nil {
		svc.Close()
		return Stats{}, err
	}
	return stats, nil
}

func (svc *Service) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			if ctx.Err() != nil {
				return nil
			}
		case evt, ok := <-svc.w.Events:
			if !ok {
				return nil
			}
			if err := svc.consume(evt); err != nil {
				return err
			}
		case err, ok := <-svc.w.Errors:
			if !ok {
				return nil
			}
			if err == nil {
				continue
			}
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				if err := svc.emit(protocol.Error{
					V:     protocol.Version,
					Type:  "error",
					Stage: "event",
					Fatal: false,
					Error: "fsnotify queue overflow",
				}); err != nil {
					return err
				}
				continue
			}
			return err
		}
	}
}

func (svc *Service) Close() error {
	if svc.w == nil {
		return nil
	}
	w := svc.w
	svc.w = nil
	return w.Close()
}

func (svc *Service) add(dir string) error {
	if _, ok := svc.dirs[dir]; ok {
		return nil
	}
	if err := svc.w.Add(dir); err != nil {
		return fmt.Errorf("add watch %s: %w", dir, err)
	}
	svc.dirs[dir] = 1
	return nil
}

func (svc *Service) consume(evt fsnotify.Event) error {
	item := filepath.Clean(evt.Name)

	if svc.match.Ignore(item) {
		if evt.Has(fsnotify.Remove) || evt.Has(fsnotify.Rename) {
			delete(svc.dirs, item)
		}
		return nil
	}

	switch {
	case evt.Has(fsnotify.Create):
		stat, err := os.Stat(item)
		if err == nil && stat.IsDir() {
			if _, err := Scan(item, svc.match, svc.add); err != nil {
				return err
			}
		}
	case evt.Has(fsnotify.Remove), evt.Has(fsnotify.Rename):
		delete(svc.dirs, item)
	}

	name := event(evt)
	if name == "" {
		return nil
	}
	if svc.filter.Ignore(item) {
		return nil
	}

	return svc.emit(protocol.Event{
		V:     protocol.Version,
		Type:  "event",
		Path:  item,
		Event: name,
	})
}

func event(evt fsnotify.Event) string {
	switch {
	case evt.Has(fsnotify.Remove), evt.Has(fsnotify.Rename):
		return "unlink"
	case evt.Has(fsnotify.Create):
		return "add"
	case evt.Has(fsnotify.Write), evt.Has(fsnotify.Chmod):
		return "change"
	default:
		return ""
	}
}
