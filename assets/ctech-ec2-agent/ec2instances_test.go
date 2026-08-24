package main

import "testing"

func TestParseEC2DescribeInstancesArgsRequiresIDs(t *testing.T) {
	if _, err := parseEC2DescribeInstancesArgs([]string{}); err == nil {
		t.Fatal("expected an error when -ids is missing")
	}
}

func TestParseEC2DescribeInstancesArgsSplitsOnComma(t *testing.T) {
	args, err := parseEC2DescribeInstancesArgs([]string{"-ids", "i-aaa,i-bbb"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(args.ids) != 2 || args.ids[0] != "i-aaa" || args.ids[1] != "i-bbb" {
		t.Fatalf("ids = %v, want [i-aaa i-bbb]", args.ids)
	}
}
