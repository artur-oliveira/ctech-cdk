package main

import (
	"context"
	"flag"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/route53"
	r53types "github.com/aws/aws-sdk-go-v2/service/route53/types"
)

type route53UpsertArgs struct {
	zoneID string
	name   string
	value  string
	ttl    int64
}

func parseRoute53UpsertArgs(argv []string) (route53UpsertArgs, error) {
	fs := flag.NewFlagSet("route53-upsert", flag.ContinueOnError)
	zoneID := fs.String("zone-id", "", "hosted zone id")
	name := fs.String("name", "", "record FQDN")
	value := fs.String("value", "", "record value (e.g. an IPv4 address)")
	ttl := fs.Int64("ttl", 10, "record TTL in seconds")
	if err := fs.Parse(argv); err != nil {
		return route53UpsertArgs{}, err
	}
	if *zoneID == "" || *name == "" || *value == "" {
		return route53UpsertArgs{}, fmt.Errorf("-zone-id, -name and -value are required")
	}
	return route53UpsertArgs{zoneID: *zoneID, name: *name, value: *value, ttl: *ttl}, nil
}

func runRoute53Upsert(ctx context.Context, argv []string) error {
	args, err := parseRoute53UpsertArgs(argv)
	if err != nil {
		return err
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := route53.NewFromConfig(cfg)

	_, err = client.ChangeResourceRecordSets(ctx, &route53.ChangeResourceRecordSetsInput{
		HostedZoneId: aws.String(args.zoneID),
		ChangeBatch: &r53types.ChangeBatch{
			Changes: []r53types.Change{{
				Action: r53types.ChangeActionUpsert,
				ResourceRecordSet: &r53types.ResourceRecordSet{
					Name:            aws.String(args.name),
					Type:            r53types.RRTypeA,
					TTL:             aws.Int64(args.ttl),
					ResourceRecords: []r53types.ResourceRecord{{Value: aws.String(args.value)}},
				},
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("upsert %s -> %s in zone %s: %w", args.name, args.value, args.zoneID, err)
	}
	return nil
}
