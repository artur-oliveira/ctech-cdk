package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

var errNotFound = errors.New("not found")

type s3CpArgs struct {
	bucket, key, dest string
}

func parseS3CpArgs(argv []string) (s3CpArgs, error) {
	fs := flag.NewFlagSet("s3-cp", flag.ContinueOnError)
	bucket := fs.String("bucket", "", "source bucket")
	key := fs.String("key", "", "source object key")
	dest := fs.String("dest", "", "local destination path")
	if err := fs.Parse(argv); err != nil {
		return s3CpArgs{}, err
	}
	if *bucket == "" || *key == "" || *dest == "" {
		return s3CpArgs{}, fmt.Errorf("-bucket, -key and -dest are required")
	}
	return s3CpArgs{bucket: *bucket, key: *key, dest: *dest}, nil
}

type s3HeadArgs struct {
	bucket, key string
}

func parseS3HeadArgs(argv []string) (s3HeadArgs, error) {
	fs := flag.NewFlagSet("s3-head", flag.ContinueOnError)
	bucket := fs.String("bucket", "", "bucket")
	key := fs.String("key", "", "object key")
	if err := fs.Parse(argv); err != nil {
		return s3HeadArgs{}, err
	}
	if *bucket == "" || *key == "" {
		return s3HeadArgs{}, fmt.Errorf("-bucket and -key are required")
	}
	return s3HeadArgs{bucket: *bucket, key: *key}, nil
}

func newS3Client(ctx context.Context) (*s3.Client, error) {
	// No AWS_REGION is set anywhere in userData — resolve it from IMDS instead
	// of failing every call with MissingRegion.
	cfg, err := config.LoadDefaultConfig(ctx, config.WithEC2IMDSRegion())
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return s3.NewFromConfig(cfg), nil
}

func runS3Cp(ctx context.Context, argv []string) error {
	args, err := parseS3CpArgs(argv)
	if err != nil {
		return err
	}
	client, err := newS3Client(ctx)
	if err != nil {
		return err
	}
	out, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(args.bucket),
		Key:    aws.String(args.key),
	})
	if err != nil {
		return fmt.Errorf("get s3://%s/%s: %w", args.bucket, args.key, err)
	}
	defer out.Body.Close()

	f, err := os.Create(args.dest)
	if err != nil {
		return fmt.Errorf("create %s: %w", args.dest, err)
	}
	defer f.Close()

	if _, err := io.Copy(f, out.Body); err != nil {
		return fmt.Errorf("write %s: %w", args.dest, err)
	}
	return nil
}

// runS3Head returns errNotFound (never a raw AWS error) when the key is
// missing, so main() exits 1 without dumping a stack of SDK error wrapping —
// callers like bootstrap-deploy.sh only ever branch on the exit code.
func runS3Head(ctx context.Context, argv []string) error {
	args, err := parseS3HeadArgs(argv)
	if err != nil {
		return err
	}
	client, err := newS3Client(ctx)
	if err != nil {
		return err
	}
	_, err = client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(args.bucket),
		Key:    aws.String(args.key),
	})
	if err != nil {
		var respErr *smithyhttp.ResponseError
		if errors.As(err, &respErr) && respErr.HTTPStatusCode() == 404 {
			return errNotFound
		}
		return fmt.Errorf("head s3://%s/%s: %w", args.bucket, args.key, err)
	}
	return nil
}
