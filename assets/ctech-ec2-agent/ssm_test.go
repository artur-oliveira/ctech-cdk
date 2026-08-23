package main

import "testing"

func TestParseSSMGetArgsRequiresName(t *testing.T) {
	if _, err := parseSSMGetArgs([]string{}); err == nil {
		t.Fatal("expected an error when -name is missing")
	}
}

func TestParseSSMGetArgsDefaultsToDecrypt(t *testing.T) {
	args, err := parseSSMGetArgs([]string{"-name", "/ctech/prod/foo"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if args.name != "/ctech/prod/foo" {
		t.Fatalf("name = %q, want /ctech/prod/foo", args.name)
	}
	if !args.decrypt {
		t.Fatal("decrypt should default to true")
	}
}

func TestParseSSMPutArgsRequiresNameAndValue(t *testing.T) {
	if _, err := parseSSMPutArgs([]string{"-name", "/x"}); err == nil {
		t.Fatal("expected an error when -value is missing")
	}
}
