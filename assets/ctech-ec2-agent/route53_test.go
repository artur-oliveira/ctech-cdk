package main

import "testing"

func TestParseRoute53UpsertArgsRequiresAllFields(t *testing.T) {
	_, err := parseRoute53UpsertArgs([]string{"-zone-id", "Z123"})
	if err == nil {
		t.Fatal("expected an error when -name and -value are missing")
	}
}

func TestParseRoute53UpsertArgsDefaultsTTL(t *testing.T) {
	args, err := parseRoute53UpsertArgs([]string{
		"-zone-id", "Z123", "-name", "cache.internal.aoctech.app", "-value", "10.0.0.5",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if args.ttl != 10 {
		t.Fatalf("ttl = %d, want default 10", args.ttl)
	}
}
