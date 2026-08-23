package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

type ssmGetArgs struct {
	name    string
	decrypt bool
}

func parseSSMGetArgs(args []string) (ssmGetArgs, error) {
	fs := flag.NewFlagSet("ssm-get", flag.ContinueOnError)
	name := fs.String("name", "", "SSM parameter name")
	decrypt := fs.Bool("decrypt", true, "decrypt SecureString parameters")
	if err := fs.Parse(args); err != nil {
		return ssmGetArgs{}, err
	}
	if *name == "" {
		return ssmGetArgs{}, fmt.Errorf("-name is required")
	}
	return ssmGetArgs{name: *name, decrypt: *decrypt}, nil
}

type ssmPutArgs struct {
	name  string
	value string
}

func parseSSMPutArgs(args []string) (ssmPutArgs, error) {
	fs := flag.NewFlagSet("ssm-put", flag.ContinueOnError)
	name := fs.String("name", "", "SSM parameter name")
	value := fs.String("value", "", "value to store")
	if err := fs.Parse(args); err != nil {
		return ssmPutArgs{}, err
	}
	if *name == "" || *value == "" {
		return ssmPutArgs{}, fmt.Errorf("-name and -value are required")
	}
	return ssmPutArgs{name: *name, value: *value}, nil
}

func newSSMClient(ctx context.Context) (*ssm.Client, error) {
	// No AWS_REGION is set anywhere in userData — resolve it from IMDS instead
	// of failing every call with MissingRegion.
	cfg, err := config.LoadDefaultConfig(ctx, config.WithEC2IMDSRegion())
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return ssm.NewFromConfig(cfg), nil
}

// runSSMGet writes the parameter value to stdout, unquoted, so callers can do
// VAR=$(ctech-ec2-agent ssm-get -name /path) — the same shape setup-ssm-env.sh
// already expects from `aws ssm get-parameter --query Parameter.Value --output text`.
func runSSMGet(ctx context.Context, argv []string) error {
	args, err := parseSSMGetArgs(argv)
	if err != nil {
		return err
	}
	client, err := newSSMClient(ctx)
	if err != nil {
		return err
	}
	out, err := client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(args.name),
		WithDecryption: aws.Bool(args.decrypt),
	})
	if err != nil {
		return fmt.Errorf("get parameter %q: %w", args.name, err)
	}
	fmt.Fprint(os.Stdout, aws.ToString(out.Parameter.Value))
	return nil
}

func runSSMPut(ctx context.Context, argv []string) error {
	args, err := parseSSMPutArgs(argv)
	if err != nil {
		return err
	}
	client, err := newSSMClient(ctx)
	if err != nil {
		return err
	}
	_, err = client.PutParameter(ctx, &ssm.PutParameterInput{
		Name:      aws.String(args.name),
		Value:     aws.String(args.value),
		Type:      ssmtypes.ParameterTypeString,
		Overwrite: aws.Bool(true),
	})
	if err != nil {
		return fmt.Errorf("put parameter %q: %w", args.name, err)
	}
	return nil
}
