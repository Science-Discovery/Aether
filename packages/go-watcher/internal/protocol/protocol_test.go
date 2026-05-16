package protocol

import (
	"strings"
	"testing"
)

func TestDecodeStart(t *testing.T) {
	msg, err := Decode(strings.NewReader(`{"v":1,"type":"start","root":"/tmp/app","ignore":[".git"],"filter":["*.log"],"mode":"limited","dirs":["/tmp/app/src"]}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}

	if msg.Type != "start" {
		t.Fatalf("expected start message, got %q", msg.Type)
	}
	if msg.Mode != "limited" {
		t.Fatalf("expected limited mode, got %q", msg.Mode)
	}
	if len(msg.Dirs) != 1 || msg.Dirs[0] != "/tmp/app/src" {
		t.Fatalf("unexpected dirs: %#v", msg.Dirs)
	}
}

func TestDecodeSync(t *testing.T) {
	msg, err := Decode(strings.NewReader(`{"v":1,"type":"sync","dirs":["/tmp/app/src","/tmp/app/docs"]}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}

	if msg.Type != "sync" {
		t.Fatalf("expected sync message, got %q", msg.Type)
	}
	if len(msg.Dirs) != 2 {
		t.Fatalf("expected 2 dirs, got %#v", msg.Dirs)
	}
}
