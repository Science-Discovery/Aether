package watch

import (
	"path/filepath"
	"testing"
)

func TestServiceLimitedSyncReplacesWatchSet(t *testing.T) {
	root := t.TempDir()
	makeDir(t, root, "src")
	makeDir(t, root, "docs")
	makeDir(t, root, "node_modules/pkg")

	svc, err := New(root, []string{"**/{node_modules,.git}"}, []string{"*.log"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()

	svc.mode = "limited"
	stats, err := svc.Start([]string{filepath.Join(root, "src"), filepath.Join(root, "node_modules")})
	if err != nil {
		t.Fatal(err)
	}

	if stats.Watched != 1 {
		t.Fatalf("expected 1 watched dir after ignore pruning, got %d", stats.Watched)
	}
	if stats.Ignored != 1 {
		t.Fatalf("expected 1 ignored dir, got %d", stats.Ignored)
	}
	if _, ok := svc.dirs[filepath.Join(root, "src")]; !ok {
		t.Fatalf("expected src watch to exist: %#v", svc.dirs)
	}

	stats, err = svc.Sync([]string{filepath.Join(root, "docs")})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Watched != 1 {
		t.Fatalf("expected 1 watched dir after sync, got %d", stats.Watched)
	}
	if _, ok := svc.dirs[filepath.Join(root, "src")]; ok {
		t.Fatalf("expected src watch to be removed: %#v", svc.dirs)
	}
	if _, ok := svc.dirs[filepath.Join(root, "docs")]; !ok {
		t.Fatalf("expected docs watch to exist: %#v", svc.dirs)
	}
}
