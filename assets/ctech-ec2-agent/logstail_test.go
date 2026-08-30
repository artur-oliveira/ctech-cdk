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

// One blank line used to stop a whole service's log shipping: PutLogEvents
// rejects a zero-length message AND fails the entire batch on one bad member,
// so every other line in that batch died with it — and the supervisor restarted
// the daemon straight back into the same bytes.
func TestBuildLogEventsDropsUnshippableLines(t *testing.T) {
	events := buildLogEvents([]string{"first", "", "second", "   ", "\t", "third"}, 1)
	if len(events) != 3 {
		t.Fatalf("expected 3 shippable events, got %d", len(events))
	}
	for i, want := range []string{"first", "second", "third"} {
		if got := *events[i].Message; got != want {
			t.Fatalf("event %d = %q, want %q", i, got, want)
		}
	}
}

func TestBuildLogEventsKeepsEveryNonBlankLine(t *testing.T) {
	// Dropping blanks must not become dropping content: a line that merely
	// looks unusual still ships.
	lines := []string{"{\"level\":\"INFO\"}", "0", " leading space", "}"}
	events := buildLogEvents(lines, 7)
	if len(events) != len(lines) {
		t.Fatalf("expected %d events, got %d", len(lines), len(events))
	}
	if *events[0].Timestamp != 7 {
		t.Fatalf("timestamp = %d, want 7", *events[0].Timestamp)
	}
}

func TestBuildLogEventsOnAllBlankBatch(t *testing.T) {
	// An all-blank batch must produce no request at all rather than an empty
	// one, which the API also rejects.
	if events := buildLogEvents([]string{"", "  "}, 1); len(events) != 0 {
		t.Fatalf("expected no events, got %d", len(events))
	}
}

// A rejection on the batch's contents will be rejected identically forever, so
// treating it as retryable is what turned one bad line into a crash loop.
func TestPermanentPutLogEventsErrorClassification(t *testing.T) {
	for _, code := range []string{"InvalidParameterException", "DataAlreadyAcceptedException", "InvalidSequenceTokenException"} {
		if !permanentPutLogEventsError(code) {
			t.Errorf("%s must be treated as permanent", code)
		}
	}
	// These may succeed on a retry; dropping their batch would lose logs.
	for _, code := range []string{"ThrottlingException", "ServiceUnavailableException", "ResourceNotFoundException", ""} {
		if permanentPutLogEventsError(code) {
			t.Errorf("%s must stay retryable", code)
		}
	}
}
