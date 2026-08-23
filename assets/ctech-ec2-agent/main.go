package main

import (
	"context"
	"errors"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ctech-ec2-agent <subcommand> [flags]")
		os.Exit(1)
	}
	ctx := context.Background()
	cmd, args := os.Args[1], os.Args[2:]

	var err error
	switch cmd {
	case "ssm-get":
		err = runSSMGet(ctx, args)
	case "ssm-put":
		err = runSSMPut(ctx, args)
	case "prefix-list":
		err = runPrefixList(ctx, args)
	case "route53-upsert":
		err = runRoute53Upsert(ctx, args)
	case "s3-cp":
		err = runS3Cp(ctx, args)
	case "s3-head":
		err = runS3Head(ctx, args)
	default:
		err = fmt.Errorf("unknown subcommand %q", cmd)
	}
	if err != nil {
		if errors.Is(err, errNotFound) {
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "ctech-ec2-agent %s: %v\n", cmd, err)
		os.Exit(1)
	}
}
