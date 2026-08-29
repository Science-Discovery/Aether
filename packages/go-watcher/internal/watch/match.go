package watch

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

type Matcher struct {
	root     string
	patterns []string
	names    []string
}

func Compile(root string, patterns []string) (*Matcher, error) {
	return compile(root, patterns, false)
}

func CompileFilter(root string, patterns []string) (*Matcher, error) {
	return compile(root, patterns, true)
}

func compile(root string, patterns []string, names bool) (*Matcher, error) {
	root = filepath.Clean(root)
	list := make([]string, 0, len(patterns))
	base := make([]string, 0, len(patterns))

	for _, raw := range patterns {
		item, err := normalize(root, raw)
		if err != nil {
			return nil, err
		}
		if item == "" || item == "." {
			continue
		}
		if !doublestar.ValidatePattern(item) {
			return nil, fmt.Errorf("unsupported ignore pattern %q", raw)
		}
		if names && !strings.Contains(item, "/") {
			base = append(base, item)
			continue
		}
		list = append(list, item)
	}

	return &Matcher{
		root:     root,
		patterns: list,
		names:    base,
	}, nil
}

func (m *Matcher) Ignore(target string) bool {
	rel, ok := m.rel(target)
	if !ok || rel == "" {
		return false
	}

	for _, item := range m.patterns {
		if doublestar.MatchUnvalidated(item, rel) {
			return true
		}
	}
	for _, item := range m.names {
		if doublestar.MatchUnvalidated(item, filepath.Base(rel)) {
			return true
		}
	}
	return false
}

func (m *Matcher) rel(target string) (string, bool) {
	rel, err := filepath.Rel(m.root, filepath.Clean(target))
	if err != nil {
		return "", false
	}
	if rel == "." {
		return "", true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func normalize(root string, raw string) (string, error) {
	if raw == "" {
		return "", nil
	}

	if filepath.IsAbs(raw) {
		rel, err := filepath.Rel(root, filepath.Clean(raw))
		if err != nil {
			return "", err
		}
		if rel == "." {
			return "", nil
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("ignore path %q is outside root", raw)
		}
		raw = rel
	}

	raw = filepath.ToSlash(filepath.Clean(raw))
	if raw == "." {
		return "", nil
	}
	return strings.TrimPrefix(raw, "./"), nil
}
