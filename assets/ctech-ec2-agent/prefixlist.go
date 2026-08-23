package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// A partial list is worse than a stale one: an unlisted edge would be treated
// as the client and become the rate-limit key. Mirrors setup-realip.sh's own
// "-lt 10" bail-out.
const minExpectedPrefixCount = 10

func validatePrefixCount(n int) error {
	if n < minExpectedPrefixCount {
		return fmt.Errorf("refusing a partial prefix list: got %d entries, want at least %d", n, minExpectedPrefixCount)
	}
	return nil
}

func runPrefixList(ctx context.Context, argv []string) error {
	fs := flag.NewFlagSet("prefix-list", flag.ContinueOnError)
	name := fs.String("name", "com.amazonaws.global.cloudfront.origin-facing", "managed prefix list name")
	region := fs.String("region", "us-east-1", "region the prefix list lives in (CloudFront's is global, in us-east-1)")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(*region))
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := ec2.NewFromConfig(cfg)

	listOut, err := client.DescribeManagedPrefixLists(ctx, &ec2.DescribeManagedPrefixListsInput{
		Filters: []ec2types.Filter{{
			Name:   aws.String("prefix-list-name"),
			Values: []string{*name},
		}},
	})
	if err != nil {
		return fmt.Errorf("describe managed prefix lists: %w", err)
	}
	if len(listOut.PrefixLists) == 0 {
		return fmt.Errorf("managed prefix list %q not found", *name)
	}
	prefixListID := aws.ToString(listOut.PrefixLists[0].PrefixListId)

	entriesOut, err := client.GetManagedPrefixListEntries(ctx, &ec2.GetManagedPrefixListEntriesInput{
		PrefixListId: aws.String(prefixListID),
	})
	if err != nil {
		return fmt.Errorf("get managed prefix list entries for %s: %w", prefixListID, err)
	}
	if err := validatePrefixCount(len(entriesOut.Entries)); err != nil {
		return err
	}

	for _, e := range entriesOut.Entries {
		fmt.Fprintln(os.Stdout, aws.ToString(e.Cidr))
	}
	return nil
}
