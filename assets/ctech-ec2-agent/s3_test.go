package main

import "testing"

func TestParseS3CpArgsRequiresAllFields(t *testing.T) {
	if _, err := parseS3CpArgs([]string{"-bucket", "b"}); err == nil {
		t.Fatal("expected an error when -key and -dest are missing")
	}
}

func TestParseS3HeadArgsRequiresBucketAndKey(t *testing.T) {
	if _, err := parseS3HeadArgs([]string{"-bucket", "b"}); err == nil {
		t.Fatal("expected an error when -key is missing")
	}
}
