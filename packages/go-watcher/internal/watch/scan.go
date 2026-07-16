package watch

import (
	"io/fs"
	"path/filepath"
)

type Stats struct {
	Watched int
	Ignored int
}

func Scan(root string, match *Matcher, fn func(string) error) (Stats, error) {
	var stats Stats

	err := filepath.WalkDir(root, func(item string, ent fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !ent.IsDir() {
			return nil
		}
		if item != root && match.Ignore(item) {
			stats.Ignored++
			return filepath.SkipDir
		}
		stats.Watched++
		return fn(item)
	})
	if err != nil {
		return Stats{}, err
	}
	return stats, nil
}
