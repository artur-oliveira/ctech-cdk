package main

import "testing"

func TestFilterCIDRsRejectsAPartialList(t *testing.T) {
	// setup-realip.sh's own rule: fewer than 10 entries means the AWS call
	// came back truncated or wrong — refuse rather than write a bad config.
	if err := validatePrefixCount(9); err == nil {
		t.Fatal("expected an error for fewer than 10 prefixes")
	}
	if err := validatePrefixCount(10); err != nil {
		t.Fatalf("10 prefixes must be accepted: %v", err)
	}
}
