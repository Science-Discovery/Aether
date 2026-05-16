package watch

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
	mode   string
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
		mode:   "full",
	}, nil
}

func (svc *Service) Start(dirs []string) (Stats, error) {
	if !filepath.IsAbs(svc.root) {
		return Stats{}, errors.New("root must be absolute")
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return Stats{}, err
	}
	svc.w = w

	if svc.mode == "limited" {
		return svc.Sync(dirs)
	}

	stats, err := Scan(svc.root, svc.match, svc.add)
	if err != nil {
		svc.Close()
		return Stats{}, err
	}
	return stats, nil
}

func (svc *Service) SetMode(mode string) {
	if mode == "limited" {
		svc.mode = mode
		return
	}
	svc.mode = "full"
}

func (svc *Service) Sync(dirs []string) (Stats, error) {
	if svc.mode != "limited" {
		return Stats{Watched: len(svc.dirs)}, nil
	}

	next := map[string]int{}
	ignored := 0
	for _, item := range dirs {
		dir, ok, err := svc.normalizeDir(item)
		if err != nil {
			return Stats{}, err
		}
		if !ok {
			continue
		}
		if svc.match.Ignore(dir) {
			ignored += 1
			continue
		}
		if err := svc.add(dir); err != nil {
			return Stats{}, err
		}
		next[dir] = 1
	}

	for item := range svc.dirs {
		if _, ok := next[item]; ok {
			continue
		}
		if err := svc.w.Remove(item); err != nil && !errors.Is(err, fsnotify.ErrNonExistentWatch) {
			return Stats{}, fmt.Errorf("remove watch %s: %w", item, err)
		}
		delete(svc.dirs, item)
	}

	return Stats{
		Watched: len(svc.dirs),
		Ignored: ignored,
	}, nil
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
		if svc.mode != "limited" && err == nil && stat.IsDir() {
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

func (svc *Service) normalizeDir(item string) (string, bool, error) {
	dir := filepath.Clean(item)
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(svc.root, dir)
	}
	rel, err := filepath.Rel(svc.root, dir)
	if err != nil {
		return "", false, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false, fmt.Errorf("watch dir escapes root: %s", item)
	}
	stat, err := os.Stat(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	if !stat.IsDir() {
		return "", false, nil
	}
	return dir, true, nil
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
