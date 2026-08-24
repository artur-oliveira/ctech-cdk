package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	case "ssm-get-by-path":
		err = runSSMGetByPath(ctx, args)
	case "asg-describe":
		err = runASGDescribe(ctx, args)
	case "ec2-describe-instances":
		err = runEC2DescribeInstances(ctx, args)
	case "prefix-list":
		err = runPrefixList(ctx, args)
	case "route53-upsert":
		err = runRoute53Upsert(ctx, args)
	case "s3-cp":
		err = runS3Cp(ctx, args)
	case "s3-head":
		err = runS3Head(ctx, args)
	case "logs-tail":
		err = runLogsTail(ctx, args)
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

func fetchInstanceID(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		"http://169.254.169.254/latest/api/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "60")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch IMDSv2 token: %w", err)
	}
	defer resp.Body.Close()
	token, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	req, err = http.NewRequestWithContext(ctx, http.MethodGet,
		"http://169.254.169.254/latest/meta-data/instance-id", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-aws-ec2-metadata-token", string(token))
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch instance id: %w", err)
	}
	defer resp2.Body.Close()
	id, err := io.ReadAll(resp2.Body)
	if err != nil {
		return "", err
	}
	return string(id), nil
}
