package watch

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestScanSkipsIgnoredSubtrees(t *testing.T) {
	root := t.TempDir()
	makeDir(t, root, "src")
	makeDir(t, root, "node_modules/pkg/a")
	makeDir(t, root, "packages/app/node_modules/x")
	makeDir(t, root, ".git/objects")
	makeDir(t, root, "packages/app/src")

	match, err := Compile(root, []string{
		"**/{node_modules,.git}",
	})
	if err != nil {
		t.Fatal(err)
	}

	var seen []string
	stats, err := Scan(root, match, func(dir string) error {
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			return err
		}
		seen = append(seen, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if stats.Ignored != 3 {
		t.Fatalf("expected 3 ignored dirs, got %d", stats.Ignored)
	}

	if slices.Contains(seen, "node_modules") || slices.Contains(seen, "packages/app/node_modules") || slices.Contains(seen, ".git") {
		t.Fatalf("ignored directories should not be watched: %v", seen)
	}

	if slices.Contains(seen, "node_modules/pkg") || slices.Contains(seen, "packages/app/node_modules/x") || slices.Contains(seen, ".git/objects") {
		t.Fatalf("ignored descendants should not be watched: %v", seen)
	}
}

func TestCompileRejectsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	_, err := Compile(root, []string{"/tmp"})
	if err == nil {
		t.Fatal("expected outside-root pattern to fail")
	}
}

func TestCompileSupportsDoublestar(t *testing.T) {
	root := t.TempDir()
	match, err := Compile(root, []string{"packages/**/cache/**"})
	if err != nil {
		t.Fatal(err)
	}

	if !match.Ignore(filepath.Join(root, "packages/app/cache/tmp")) {
		t.Fatal("expected doublestar pattern to match nested cache path")
	}

	if match.Ignore(filepath.Join(root, "packages/app/src/tmp")) {
		t.Fatal("did not expect unrelated path to match")
	}
}

func TestCompileSupportsBraceGlobstar(t *testing.T) {
	root := t.TempDir()
	match, err := Compile(root, []string{"**/{node_modules,dist,.git}"})
	if err != nil {
		t.Fatal(err)
	}

	if !match.Ignore(filepath.Join(root, "node_modules")) {
		t.Fatal("expected root globstar alternation to match")
	}

	if !match.Ignore(filepath.Join(root, "packages/app/dist")) {
		t.Fatal("expected nested globstar alternation to match")
	}

	if !match.Ignore(filepath.Join(root, ".git")) {
		t.Fatal("expected dot dir globstar alternation to match")
	}

	if match.Ignore(filepath.Join(root, "packages/app/src")) {
		t.Fatal("did not expect unrelated path to match")
	}
}

func TestCompileFilterMatchesNestedBaseName(t *testing.T) {
	root := t.TempDir()
	match, err := CompileFilter(root, []string{"Thumbs.db", "*.log"})
	if err != nil {
		t.Fatal(err)
	}

	if !match.Ignore(filepath.Join(root, "a/b/Thumbs.db")) {
		t.Fatal("expected nested basename to match")
	}

	if !match.Ignore(filepath.Join(root, "a/b/app.log")) {
		t.Fatal("expected nested glob basename to match")
	}

	if match.Ignore(filepath.Join(root, "a/b/app.ts")) {
		t.Fatal("did not expect unrelated file to match")
	}
}

func TestCompileFilterKeepsRelativePathGlobs(t *testing.T) {
	root := t.TempDir()
	match, err := CompileFilter(root, []string{"logs/**"})
	if err != nil {
		t.Fatal(err)
	}

	if !match.Ignore(filepath.Join(root, "logs/app/current.txt")) {
		t.Fatal("expected relative path glob to match")
	}

	if match.Ignore(filepath.Join(root, "src/current.txt")) {
		t.Fatal("did not expect unrelated path to match")
	}
}

func TestCompileSupportsLiteralPathScanPruning(t *testing.T) {
	root := t.TempDir()
	makeDir(t, root, "packages/app/cache/tmp")
	makeDir(t, root, "packages/app/src")

	match, err := Compile(root, []string{"packages/app/cache"})
	if err != nil {
		t.Fatal(err)
	}

	var seen []string
	stats, err := Scan(root, match, func(dir string) error {
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			return err
		}
		seen = append(seen, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if stats.Ignored != 1 {
		t.Fatalf("expected 1 ignored dir, got %d", stats.Ignored)
	}

	if slices.Contains(seen, "packages/app/cache") || slices.Contains(seen, "packages/app/cache/tmp") {
		t.Fatalf("literal ignored path should prune subtree: %v", seen)
	}
}

func makeDir(t *testing.T, root string, rel string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
		t.Fatal(err)
	}
}
