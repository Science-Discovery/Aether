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
}

func Compile(root string, patterns []string) (*Matcher, error) {
	root = filepath.Clean(root)
	list := make([]string, 0, len(patterns))

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
		list = append(list, item)
	}

	return &Matcher{
		root:     root,
		patterns: list,
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
