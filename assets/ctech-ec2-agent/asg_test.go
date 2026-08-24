package main

import "testing"

func TestParseASGDescribeArgsRequiresNames(t *testing.T) {
	if _, err := parseASGDescribeArgs([]string{}); err == nil {
		t.Fatal("expected an error when -names is missing")
	}
}

func TestParseASGDescribeArgsSplitsOnComma(t *testing.T) {
	args, err := parseASGDescribeArgs([]string{"-names", "prod-ctech-account,prod-ctech-dfe"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"prod-ctech-account", "prod-ctech-dfe"}
	if len(args.names) != len(want) || args.names[0] != want[0] || args.names[1] != want[1] {
		t.Fatalf("names = %v, want %v", args.names, want)
	}
}
