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
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
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

type s3PutArgs struct {
	bucket, key, file string
}

func parseS3PutArgs(argv []string) (s3PutArgs, error) {
	fs := flag.NewFlagSet("s3-put", flag.ContinueOnError)
	bucket := fs.String("bucket", "", "destination bucket")
	key := fs.String("key", "", "destination object key")
	file := fs.String("file", "", "local source file")
	if err := fs.Parse(argv); err != nil {
		return s3PutArgs{}, err
	}
	if *bucket == "" || *key == "" || *file == "" {
		return s3PutArgs{}, fmt.Errorf("-bucket, -key and -file are required")
	}
	return s3PutArgs{bucket: *bucket, key: *key, file: *file}, nil
}

// runS3Put always requests a SHA-256 checksum: this exists specifically for
// bootstrap-alpine.sh.tftpl's HAProxy artifact cache, which is keyed by its
// SHA-256 digest — the same reason the AL2023 script's aws s3api put-object
// call always passes --checksum-algorithm SHA256.
func runS3Put(ctx context.Context, argv []string) error {
	args, err := parseS3PutArgs(argv)
	if err != nil {
		return err
	}
	client, err := newS3Client(ctx)
	if err != nil {
		return err
	}
	f, err := os.Open(args.file)
	if err != nil {
		return fmt.Errorf("open %s: %w", args.file, err)
	}
	defer f.Close()

	_, err = client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:            aws.String(args.bucket),
		Key:               aws.String(args.key),
		Body:              f,
		ChecksumAlgorithm: s3types.ChecksumAlgorithmSha256,
	})
	if err != nil {
		return fmt.Errorf("put s3://%s/%s: %w", args.bucket, args.key, err)
	}
	return nil
}
