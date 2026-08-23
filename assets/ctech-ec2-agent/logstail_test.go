package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDetectRotationOnInodeChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := statInode(path)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate logrotate: rename the old file away, create a fresh one at the
	// same path. The inode must differ even though the path is identical.
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("second\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st2, err := statInode(path)
	if err != nil {
		t.Fatal(err)
	}
	if st == st2 {
		t.Fatal("expected a different inode after rotation")
	}
}

func TestBatcherFlushesOnSizeThreshold(t *testing.T) {
	b := newBatcher(2, time.Hour) // huge interval: only size should trigger it
	if b.add("one") {
		t.Fatal("must not flush before the threshold")
	}
	if !b.add("two") {
		t.Fatal("must flush once the threshold is reached")
	}
	if len(b.drain()) != 2 {
		t.Fatal("drain must return everything added since the last drain")
	}
}

func TestBatcherFlushesOnInterval(t *testing.T) {
	b := newBatcher(1000, time.Millisecond)
	b.add("one")
	time.Sleep(5 * time.Millisecond)
	if !b.dueForFlush() {
		t.Fatal("must be due for flush once the interval elapses")
	}
}
